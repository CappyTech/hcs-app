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
// Materials or labour: each line on a job is one or the other, sorted the way
// the CIS returns sort a subcontractor's invoice (returnsController
// classifyLines): its ChargeType, then its nominal code (cisMappings), then
// its nominal name or description ("material" / "labour", "subcontract").
// A line none of those decide is labour when the supplier is a CIS
// subcontractor (cisSupplierQuery) and materials otherwise. A CIS deduction
// line is neither: the deduction is paid to HMRC, so it doesn't lower the
// job's cost, and it's left out of both.
//
// The helpers above "Database" are pure, so the sums can be tested without a
// database.
import mdb from './mongooseDatabaseService.js';
import cisMappings from '../config/cisMappings.js';
import { cisSupplierQuery } from '../../services/cisService.js';

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

export const ROLES = ['materials', 'labour', 'cis'];

/** A supplier code as compared: trimmed, upper case. */
export const codeKey = (v) => String(v ?? '').trim().toUpperCase();

const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Whether a purchase line is 'materials', 'labour' or 'cis' (a CIS
 * deduction, counted as neither). See the header for the order of checks.
 *
 * @param {object|null} line - one of a purchase's LineItems (null: a purchase with none)
 * @param {object} [header] - the purchase, for its SupplierCode
 * @param {Set<string>} [subcontractorCodes] - codeKey()s of CIS subcontractors
 */
export function lineRole(line, header, subcontractorCodes = new Set()) {
  const fallback = subcontractorCodes.has(codeKey(header?.SupplierCode)) ? 'labour' : 'materials';
  if (!line) return fallback;
  const m = cisMappings;
  const ct = line.ChargeType != null ? Number(line.ChargeType) : null;
  if (ct === m.chargeTypes.materials) return 'materials';
  if (ct === m.chargeTypes.labour) return 'labour';
  if (ct === m.chargeTypes.cisDeduction) return 'cis';
  const nc = line.NominalCode != null ? Number(line.NominalCode) : null;
  if (nc != null) {
    if ((m.materialsNominalCodes || []).includes(nc)) return 'materials';
    if ((m.labourNominalCodes || []).includes(nc)) return 'labour';
    if ((m.cisDeductionNominalCodes || []).includes(nc)) return 'cis';
  }
  const name = nonEmpty(line.NominalName) ?? nonEmpty(line.Description) ?? '';
  if (/material/i.test(name)) return 'materials';
  if (/labour|labor|subcontract/i.test(name)) return 'labour';
  return fallback;
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
 * @param {object} purchase
 * @param {{ subcontractorCodes?: Set<string> }} [opts] - for each line's role (lineRole)
 * @returns {Array<{ project: number|null, net: number, description: string, nominal: number|null, role: string }>}
 */
export function costLines(purchase, { subcontractorCodes } = {}) {
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
      role: lineRole(line, purchase, subcontractorCodes),
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
 * The MongoDB expression for one unwound line's role, mirroring lineRole().
 *
 * @param {string[]} subcontractorCodes - codeKey()s of CIS subcontractors
 */
export function roleExpr(subcontractorCodes = []) {
  const m = cisMappings;
  const toNum = (path) => ({ $convert: { input: path, to: 'double', onError: null, onNull: null } });
  const ct = toNum('$LineItems.ChargeType');
  const nc = toNum('$LineItems.NominalCode');
  const str = (path) => ({ $cond: [{ $and: [{ $eq: [{ $type: path }, 'string'] }, { $ne: [path, ''] }] }, path, null] });
  const name = { $ifNull: [str('$LineItems.NominalName'), { $ifNull: [str('$LineItems.Description'), ''] }] };
  const supplier = { $toUpper: { $trim: { input: { $convert: { input: '$SupplierCode', to: 'string', onError: '', onNull: '' } } } } };
  const fallback = { $cond: [{ $in: [supplier, subcontractorCodes] }, 'labour', 'materials'] };
  const inList = (list) => ({ $and: [{ $ne: [nc, null] }, { $in: [nc, (list || []).map(Number)] }] });
  return {
    $switch: {
      branches: [
        { case: { $not: [{ $eq: [{ $type: '$LineItems' }, 'object'] }] }, then: fallback },
        { case: { $eq: [ct, m.chargeTypes.materials] }, then: 'materials' },
        { case: { $eq: [ct, m.chargeTypes.labour] }, then: 'labour' },
        { case: { $eq: [ct, m.chargeTypes.cisDeduction] }, then: 'cis' },
        { case: inList(m.materialsNominalCodes), then: 'materials' },
        { case: inList(m.labourNominalCodes), then: 'labour' },
        { case: inList(m.cisDeductionNominalCodes), then: 'cis' },
        { case: { $regexMatch: { input: name, regex: 'material', options: 'i' } }, then: 'materials' },
        { case: { $regexMatch: { input: name, regex: 'labour|labor|subcontract', options: 'i' } }, then: 'labour' },
      ],
      default: fallback,
    },
  };
}

/**
 * The aggregate behind purchaseCostsByProject(): purchases with a line or
 * header on one of the jobs → one row per line → its effective job → only
 * lines on the jobs asked for → totals per purchase, then per job, with the
 * materials and labour lines summed apart (net is every line, as KashFlow has it).
 *
 * @param {number[]} numbers - normalised job numbers
 * @param {string[]} [subcontractorCodes] - codeKey()s of CIS subcontractors
 */
export function costsPipeline(numbers, subcontractorCodes = []) {
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
    { $addFields: { _net: costNetExpr(), _role: roleExpr(subcontractorCodes) } },
    { $group: {
      _id: { project: '$_project', number: '$Number' },
      net: { $sum: '$_net' },
      materials: { $sum: { $cond: [{ $eq: ['$_role', 'materials'] }, '$_net', 0] } },
      labour: { $sum: { $cond: [{ $eq: ['$_role', 'labour'] }, '$_net', 0] } },
      lines: { $sum: 1 },
    } },
    { $group: {
      _id: '$_id.project', net: { $sum: '$net' }, materials: { $sum: '$materials' }, labour: { $sum: '$labour' },
      purchases: { $sum: 1 }, lines: { $sum: '$lines' },
    } },
  ];
}

/**
 * Turns the aggregate's rows into the result Map: every job asked for gets an
 * entry, zero when it has no purchases.
 */
export function costsFromRows(numbers, rows) {
  const out = new Map(numbers.map((n) => [n, { net: 0, materials: 0, labour: 0, purchases: 0, lines: 0 }]));
  for (const row of rows || []) {
    const n = Number(row._id);
    if (!out.has(n)) continue;
    out.set(n, {
      net: roundPence(row.net), materials: roundPence(row.materials), labour: roundPence(row.labour),
      purchases: row.purchases || 0, lines: row.lines || 0,
    });
  }
  return out;
}

/**
 * Groups purchases into the job page's list: one entry per purchase with only
 * its lines on that job, newest first, and the totals: net (every line),
 * materials and labour (lineRole; CIS deduction lines are in neither).
 *
 * @param {number|string} projectNumber
 * @param {object[]} purchases
 * @param {{ subcontractorCodes?: Set<string> }} [opts]
 * @returns {{ purchases: Array<{ number, date, supplierCode, supplierName, lines: Array<{ description, net, nominal, role }>, net, materials, labour }>, net: number, materials: number, labour: number }}
 */
export function purchaseListForProject(projectNumber, purchases, opts = {}) {
  const n = Number(projectNumber);
  const list = [];
  const sumRole = (lines, role) => roundPence(lines.reduce((s, l) => s + (l.role === role ? l.net : 0), 0));
  for (const p of purchases || []) {
    const lines = costLines(p, opts).filter((l) => l.project === n);
    if (!lines.length) continue;
    list.push({
      number: p.Number,
      date: p.IssuedDate ?? null,
      supplierCode: p.SupplierCode ?? '',
      supplierName: p.SupplierName ?? '',
      lines: lines.map(({ description, net, nominal, role }) => ({ description, net, nominal, role })),
      net: roundPence(lines.reduce((s, l) => s + l.net, 0)),
      materials: sumRole(lines, 'materials'),
      labour: sumRole(lines, 'labour'),
    });
  }
  const time = (d) => (d ? new Date(d).getTime() || 0 : 0);
  list.sort((a, b) => time(b.date) - time(a.date) || (b.number ?? 0) - (a.number ?? 0));
  const total = (k) => roundPence(list.reduce((s, p) => s + p[k], 0));
  return { purchases: list, net: total('net'), materials: total('materials'), labour: total('labour') };
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
 * The codeKey()s of the CIS subcontractors (cisSupplierQuery), so a line
 * nothing else sorts can be counted as their labour. Empty when suppliers
 * aren't synced.
 *
 * @returns {Promise<Set<string>>}
 */
export async function subcontractorCodes() {
  const model = mdb.REST?.supplier;
  if (!model) return new Set();
  const rows = await model.find(cisSupplierQuery()).select('Code').lean();
  return new Set((rows || []).map((r) => codeKey(r.Code)).filter(Boolean));
}

/**
 * Net purchase costs for many jobs at once, in one aggregate.
 *
 * @param {Array<number|string>} projectNumbers
 * @returns {Promise<Map<number, { net: number, materials: number, labour: number, purchases: number, lines: number }>>}
 */
export async function purchaseCostsByProject(projectNumbers) {
  const numbers = normaliseProjectNumbers(projectNumbers);
  if (!numbers.length) return new Map();
  const codes = await subcontractorCodes();
  const rows = await restModel('purchase').aggregate(costsPipeline(numbers, [...codes]));
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
  if (n == null) return { purchases: [], net: 0, materials: 0, labour: 0 };
  const [purchases, codes] = await Promise.all([
    restModel('purchase')
      .find({ $and: [{ $or: [{ 'LineItems.ProjectNumber': n }, { ProjectNumber: n }] }, NOT_DELETED] })
      .select('Number IssuedDate SupplierCode SupplierName ProjectNumber LineItems Type NetAmount GrossAmount Currency')
      .lean(),
    subcontractorCodes(),
  ]);
  return purchaseListForProject(n, purchases, { subcontractorCodes: codes });
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

export default { purchaseCostsByProject, purchasesForProject, kashflowProjectFigures, subcontractorCodes };
