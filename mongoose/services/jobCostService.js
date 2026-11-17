// Job costs: what each job (a KashFlow project, 41xxx) has cost in purchases.
//
// Read from the synced REST purchases. A purchase is tied to a job per line:
// each line can carry its own ProjectNumber, and the header may carry one too,
// which applies to any line that doesn't say. So a single supplier invoice can
// be split across several jobs, and only the lines on a job count towards it.
//
// Amounts are net (no VAT): Quantity × Rate per line, rounded to pence, in
// pounds (a foreign-currency purchase uses the line's HomeCurrencyRate).
//
// Credit notes: KashFlow stores a purchase credit note as a purchase with
// negative totals (live purchase 2435 has gross -576), so its lines are
// normally negative already. As a safeguard, a purchase whose Type mentions
// "credit" or "refund" (case-insensitive) and whose header total is still
// positive has its lines turned negative. Every other Type ("Purchase" is the
// only value documented, expenses included) counts as it is.
//
// Deleted purchases are left out: hcs-sync keeps KashFlow's DeletedAt date on
// voided records and its own legacy deletedAt flag, so either being a date
// means the purchase no longer exists in KashFlow.
//
// The helpers above "Database" are pure, so the sums can be tested without a
// database. Nothing calls this yet; the Job Register will show each job's costs.
import mdb from './mongooseDatabaseService.js';

const CREDIT_TYPE = /credit|refund/i;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Rounds to pence, half away from zero. The tiny nudge stops 1.005 × 100
 * (100.4999…) rounding down. costNetExpr() rounds the same way in MongoDB, so
 * the aggregate and the job page agree to the penny.
 */
export function roundPence(n) {
  const x = Number(n) || 0;
  const pence = Math.floor(Math.abs(x) * 100 + 0.5 + 1e-9);
  return pence === 0 ? 0 : Math.sign(x) * pence / 100;
}

/** True when the header's Currency is foreign (an exchange rate other than 1). */
function isForeign(header) {
  const rate = header?.Currency?.ExchangeRate;
  return isNum(rate) && rate !== 0 && rate !== 1;
}

/**
 * A line's net amount (excludes VAT): Quantity × Rate rounded to pence. On a
 * foreign-currency purchase the line's HomeCurrencyRate is used when present,
 * so the figure is in pounds. When Quantity or Rate is missing, a line-level
 * NetAmount / Net / Amount is used if there is one; otherwise 0.
 *
 * @param {object} line - one of a purchase's LineItems
 * @param {object} [header] - the purchase, for its Currency
 * @returns {number}
 */
export function lineNet(line, header) {
  if (!line) return 0;
  const rate = isForeign(header) && isNum(line.HomeCurrencyRate) ? line.HomeCurrencyRate : line.Rate;
  if (isNum(line.Quantity) && isNum(rate)) return roundPence(line.Quantity * rate);
  for (const key of ['NetAmount', 'Net', 'Amount']) {
    if (isNum(line[key])) return roundPence(line[key]);
  }
  return 0;
}

/**
 * The job a line belongs to: its own ProjectNumber, else the header's.
 * A line's 0 is kept (KashFlow's "no project"), so it doesn't fall back.
 *
 * @returns {number|null}
 */
export function lineProject(line, header) {
  return line?.ProjectNumber ?? header?.ProjectNumber ?? null;
}

/** True when the purchase's Type marks it as a credit note or refund. */
export function isCreditType(purchase) {
  return typeof purchase?.Type === 'string' && CREDIT_TYPE.test(purchase.Type);
}

/**
 * -1 when the purchase's lines must be turned negative: a credit-note Type
 * whose header total (NetAmount, else GrossAmount) is positive or missing.
 * A credit note KashFlow already stored negative keeps its signs.
 */
export function purchaseSign(purchase) {
  if (!isCreditType(purchase)) return 1;
  const total = isNum(purchase.NetAmount) ? purchase.NetAmount : purchase.GrossAmount;
  return isNum(total) && total <= 0 ? 1 : -1;
}

/**
 * The purchase's lines with their job and signed net. A purchase synced with
 * no LineItems (KashFlow sometimes returns none) counts as one line of its
 * header NetAmount, on the header's job.
 *
 * @returns {Array<{ project: number|null, net: number, description: string, nominal: number|null }>}
 */
export function costLines(purchase) {
  const sign = purchaseSign(purchase);
  const items = Array.isArray(purchase?.LineItems) && purchase.LineItems.length
    ? purchase.LineItems
    : [null];
  return items.map((line) => {
    const net = line ? lineNet(line, purchase) : roundPence(isNum(purchase?.NetAmount) ? purchase.NetAmount : 0);
    return {
      project: line ? lineProject(line, purchase) : (purchase?.ProjectNumber ?? null),
      net: sign * net || 0,
      description: line?.Description ?? '',
      nominal: line?.NominalCode ?? null,
    };
  });
}

/** Unique finite job numbers from whatever the caller passes (strings allowed). */
export function normaliseProjectNumbers(projectNumbers) {
  const list = Array.isArray(projectNumbers) ? projectNumbers : [projectNumbers];
  return [...new Set(list.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
}

/** Matches purchases still in KashFlow (neither deletion date set). */
export const NOT_DELETED = { $nor: [{ DeletedAt: { $type: 'date' } }, { deletedAt: { $type: 'date' } }] };

/**
 * The MongoDB expression for one unwound line's signed net, mirroring
 * costLines(): `$LineItems` is the line (missing when the purchase had none).
 */
export function costNetExpr() {
  const num = (path) => ({ $isNumber: path });
  const foreign = {
    $and: [
      num('$Currency.ExchangeRate'),
      { $ne: ['$Currency.ExchangeRate', 0] },
      { $ne: ['$Currency.ExchangeRate', 1] },
      num('$LineItems.HomeCurrencyRate'),
    ],
  };
  const rate = { $cond: [foreign, '$LineItems.HomeCurrencyRate', '$LineItems.Rate'] };
  const raw = {
    $switch: {
      branches: [
        { case: { $not: [{ $eq: [{ $type: '$LineItems' }, 'object'] }] },
          then: { $cond: [num('$NetAmount'), '$NetAmount', 0] } },
        { case: { $and: [num('$LineItems.Quantity'), { $isNumber: rate }] },
          then: { $multiply: ['$LineItems.Quantity', rate] } },
        { case: num('$LineItems.NetAmount'), then: '$LineItems.NetAmount' },
        { case: num('$LineItems.Net'), then: '$LineItems.Net' },
        { case: num('$LineItems.Amount'), then: '$LineItems.Amount' },
      ],
      default: 0,
    },
  };
  // roundPence(): sign × floor(|x| × 100 + 0.5 + 1e-9) / 100
  const rounded = {
    $let: {
      vars: { x: raw },
      in: {
        $multiply: [
          { $cond: [{ $lt: ['$$x', 0] }, -1, 1] },
          { $divide: [{ $floor: { $add: [{ $multiply: [{ $abs: '$$x' }, 100] }, 0.5, 1e-9] } }, 100] },
        ],
      },
    },
  };
  // purchaseSign(): -1 for a credit-note Type not already stored negative.
  const typeStr = { $cond: [{ $eq: [{ $type: '$Type' }, 'string'] }, '$Type', ''] };
  const total = { $cond: [num('$NetAmount'), '$NetAmount', '$GrossAmount'] };
  const sign = {
    $cond: [
      { $and: [
        { $regexMatch: { input: typeStr, regex: CREDIT_TYPE.source, options: 'i' } },
        { $not: [{ $and: [{ $isNumber: total }, { $lte: [total, 0] }] }] },
      ] },
      -1,
      1,
    ],
  };
  return { $multiply: [sign, rounded] };
}

/**
 * The aggregate behind purchaseCostsByProject(): purchases with a line or
 * header on one of the jobs → one row per line → its effective job → only
 * lines on the jobs asked for → totals per purchase, then per job.
 *
 * @param {number[]} numbers - normalised job numbers
 */
export function costsPipeline(numbers) {
  return [
    { $match: {
      $and: [
        { $or: [{ 'LineItems.ProjectNumber': { $in: numbers } }, { ProjectNumber: { $in: numbers } }] },
        NOT_DELETED,
      ],
    } },
    { $unwind: { path: '$LineItems', preserveNullAndEmptyArrays: true } },
    { $addFields: {
      _project: {
        $cond: [
          { $eq: [{ $type: '$LineItems' }, 'object'] },
          { $ifNull: ['$LineItems.ProjectNumber', '$ProjectNumber'] },
          '$ProjectNumber',
        ],
      },
    } },
    { $match: { _project: { $in: numbers } } },
    { $group: { _id: { project: '$_project', number: '$Number' }, net: { $sum: costNetExpr() }, lines: { $sum: 1 } } },
    { $group: { _id: '$_id.project', net: { $sum: '$net' }, purchases: { $sum: 1 }, lines: { $sum: '$lines' } } },
  ];
}

/**
 * Turns the aggregate's rows into the result Map: every job asked for gets an
 * entry, zero when it has no purchases.
 */
export function costsFromRows(numbers, rows) {
  const out = new Map(numbers.map((n) => [n, { net: 0, purchases: 0, lines: 0 }]));
  for (const row of rows || []) {
    const n = Number(row._id);
    if (!out.has(n)) continue;
    out.set(n, { net: roundPence(row.net), purchases: row.purchases || 0, lines: row.lines || 0 });
  }
  return out;
}

/**
 * Groups purchases into the job page's list: one entry per purchase with only
 * its lines on that job, newest first, and the total.
 *
 * @returns {{ purchases: Array<{ number, date, supplierCode, supplierName, lines: Array<{ description, net, nominal }>, net }>, net: number }}
 */
export function purchaseListForProject(projectNumber, purchases) {
  const n = Number(projectNumber);
  const list = [];
  for (const p of purchases || []) {
    const lines = costLines(p).filter((l) => l.project === n);
    if (!lines.length) continue;
    list.push({
      number: p.Number,
      date: p.IssuedDate ?? null,
      supplierCode: p.SupplierCode ?? '',
      supplierName: p.SupplierName ?? '',
      lines: lines.map(({ description, net, nominal }) => ({ description, net, nominal })),
      net: roundPence(lines.reduce((s, l) => s + l.net, 0)),
    });
  }
  const time = (d) => (d ? new Date(d).getTime() || 0 : 0);
  list.sort((a, b) => time(b.date) - time(a.date) || (b.number ?? 0) - (a.number ?? 0));
  return { purchases: list, net: roundPence(list.reduce((s, p) => s + p.net, 0)) };
}

/** KashFlow's own figures per project, null where a figure is missing. */
export function figuresFromProjects(numbers, projects) {
  const out = new Map();
  for (const p of projects || []) {
    const n = Number(p.Number);
    if (!numbers.includes(n)) continue;
    out.set(n, {
      actualPurchases: isNum(p.ActualPurchasesAmount) ? p.ActualPurchasesAmount : null,
      actualSales: isNum(p.ActualSalesAmount) ? p.ActualSalesAmount : null,
    });
  }
  return out;
}

// ── Database ─────────────────────────────────────────────────────────────────

function restModel(name) {
  const model = mdb.REST?.[name];
  if (!model) throw new Error(`REST ${name} model not available`);
  return model;
}

/**
 * Net purchase costs for many jobs at once, in one aggregate.
 *
 * @param {Array<number|string>} projectNumbers
 * @returns {Promise<Map<number, { net: number, purchases: number, lines: number }>>}
 */
export async function purchaseCostsByProject(projectNumbers) {
  const numbers = normaliseProjectNumbers(projectNumbers);
  if (!numbers.length) return new Map();
  const rows = await restModel('purchase').aggregate(costsPipeline(numbers));
  return costsFromRows(numbers, rows);
}

/**
 * One job's purchases for its page: only the lines on that job, newest first.
 *
 * @param {number|string} projectNumber
 * @returns {Promise<{ purchases: Array<object>, net: number }>}
 */
export async function purchasesForProject(projectNumber) {
  const [n] = normaliseProjectNumbers([projectNumber]);
  if (n == null) return { purchases: [], net: 0 };
  const purchases = await restModel('purchase')
    .find({ $and: [{ $or: [{ 'LineItems.ProjectNumber': n }, { ProjectNumber: n }] }, NOT_DELETED] })
    .select('Number IssuedDate SupplierCode SupplierName ProjectNumber LineItems Type NetAmount GrossAmount Currency')
    .lean();
  return purchaseListForProject(n, purchases);
}

/**
 * KashFlow's own ActualPurchasesAmount / ActualSalesAmount per project, from
 * the synced REST projects, to cross-check the sums above. Jobs with no
 * synced project are absent from the Map.
 *
 * @param {Array<number|string>} projectNumbers
 * @returns {Promise<Map<number, { actualPurchases: number|null, actualSales: number|null }>>}
 */
export async function kashflowProjectFigures(projectNumbers) {
  const numbers = normaliseProjectNumbers(projectNumbers);
  if (!numbers.length) return new Map();
  const projects = await restModel('project')
    .find({ $and: [{ Number: { $in: numbers } }, NOT_DELETED] })
    .select('Number ActualPurchasesAmount ActualSalesAmount')
    .lean();
  return figuresFromProjects(numbers, projects);
}

export default { purchaseCostsByProject, purchasesForProject, kashflowProjectFigures };
