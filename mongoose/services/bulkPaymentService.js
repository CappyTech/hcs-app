import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import kfSession from '../../services/kashflowSessionService.js';

/**
 * bulkPaymentService.js
 *
 * Records a single "bulk payment" against many outstanding supplier
 * (purchase) invoices in KashFlow — the write half of the reconciliation
 * story that bankLinkService already reads (a `purchasebatchpayment` bank
 * line resolved via `PaymentLines.BulkPaymentNumber`).
 *
 * DATA SOURCES
 * - The outstanding list is read from the local `purchases` collection, which
 *   hcs-sync keeps in step with KashFlow. That mirror LAGS the live ledger, so
 *   a purchase shown as owing here may already have been settled directly in
 *   KashFlow. Every amount is therefore RE-VERIFIED live (`GET /purchases/:n`)
 *   before a payment is created — see `reverify()` — and again server-side at
 *   the moment of the write.
 * - "Pay from" accounts come from the synced `bankAccount` collection.
 *
 * THE WRITE
 * KashFlow's BulkPayment_Create is `POST /purchases/bulk/payments`. There is no
 * wrapper for it in hcs-sync (that service is a read-only mirror by design), so
 * the POST is issued here directly, using the same session-token auth
 * (`withKfAuth` + `KfToken`) that paperlessController uses to create purchases.
 *
 * `Method` is an opaque numeric KashFlow code throughout this app (the paperless
 * draft offers datalist suggestions from observed values rather than labels);
 * this module follows the same convention.
 */

const KF_BASE = () =>
  (process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2').replace(/\/+$/, '');

const kfAxios = kfSession.kfAxios;

/** Round to 2dp as a Number, guarding against binary-float drift on money. */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function PurchaseModel() {
  return mdb.REST && mdb.REST.purchase;
}
function BankAccountModel() {
  return mdb.REST && mdb.REST.bankAccount;
}

/**
 * A purchase is outstanding when it isn't paid or cancelled and money is still
 * owed on it. DueAmount can't settle that alone: it reads 0 on unpaid purchases
 * (hcs-sync stores it as KashFlow returns it), so a 0 or missing DueAmount falls
 * back to GrossAmount − TotalPaidAmount. A positive DueAmount is still taken as
 * read.
 */
const SETTLED_STATUSES = ['Paid', 'Cancelled'];
const OUTSTANDING_QUERY = {
  Status: { $nin: SETTLED_STATUSES },
  deletedAt: null,
  $expr: {
    $or: [
      { $gt: ['$DueAmount', 0] },
      { $gt: [{ $subtract: [{ $ifNull: ['$GrossAmount', 0] }, { $ifNull: ['$TotalPaidAmount', 0] }] }, 0] },
    ],
  },
};

/** Amount still owed on a purchase (synced doc or live KashFlow read), mirroring OUTSTANDING_QUERY. */
export function outstandingAmount(p) {
  if (p == null || SETTLED_STATUSES.includes(p.Status)) return 0;
  if (Number(p.DueAmount) > 0) return money(p.DueAmount);
  return money(Number(p.GrossAmount || 0) - Number(p.TotalPaidAmount || 0));
}

/** Bank accounts available as the "pay from" source. */
export async function listBankAccounts() {
  const BankAccount = BankAccountModel();
  if (!BankAccount) return [];
  try {
    return await BankAccount.find({
      $or: [{ IsArchived: { $ne: true } }, { IsArchived: { $exists: false } }],
    })
      .select('Id AccountName Code IsDefaultAccount')
      .sort({ IsDefaultAccount: -1, AccountName: 1 })
      .lean();
  } catch (e) {
    logger.warn('[bulkPay] listBankAccounts failed: ' + e.message);
    return [];
  }
}

/**
 * Distinct AccountId / Method values seen on existing PaymentLines, so the
 * form can suggest the accounts and method codes actually used here — the same
 * approach as the paperless purchase draft.
 */
export async function paymentSuggestions() {
  const Purchase = PurchaseModel();
  if (!Purchase) return { accounts: [], methods: [] };
  try {
    const agg = await Purchase.aggregate([
      { $project: { pl: { $ifNull: ['$PaymentLines', '$data.PaymentLines'] } } },
      { $unwind: '$pl' },
      {
        $facet: {
          accounts: [
            { $match: { 'pl.AccountId': { $type: 'number' } } },
            { $group: { _id: '$pl.AccountId', count: { $sum: 1 }, lastDate: { $max: '$pl.Date' } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
          ],
          methods: [
            { $match: { 'pl.Method': { $type: 'number' } } },
            { $group: { _id: '$pl.Method', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
          ],
        },
      },
    ]);
    return {
      accounts: (agg?.[0]?.accounts || []).map((a) => ({ AccountId: a._id, count: a.count })),
      methods: (agg?.[0]?.methods || []).map((m) => ({ Method: m._id, count: m.count })),
    };
  } catch (e) {
    logger.warn('[bulkPay] paymentSuggestions failed: ' + e.message);
    return { accounts: [], methods: [] };
  }
}

/** Suppliers that currently have at least one outstanding purchase. */
export async function listOutstandingSuppliers() {
  const Purchase = PurchaseModel();
  if (!Purchase) return [];
  try {
    const rows = await Purchase.aggregate([
      { $match: OUTSTANDING_QUERY },
      {
        $group: {
          _id: { id: '$SupplierId', name: '$SupplierName', code: '$SupplierCode' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.name': 1 } },
      { $limit: 500 },
    ]);
    return rows.map((r) => ({
      SupplierId: r._id.id ?? null,
      SupplierName: r._id.name || '(no name)',
      SupplierCode: r._id.code || '',
      count: r.count,
    }));
  } catch (e) {
    logger.warn('[bulkPay] listOutstandingSuppliers failed: ' + e.message);
    return [];
  }
}

export function clampPageSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(10, Math.trunc(n)));
}

/**
 * Page of outstanding purchases from the synced mirror, newest-issued first.
 * Filters: supplierId (exact), search (Number / SupplierName / SupplierReference,
 * case-insensitive substring — never compiled as a RegExp pattern from user
 * input), issued-date from/to.
 */
export async function listOutstanding({ supplierId, search, from, to, page = 1, pageSize = 50 } = {}) {
  const Purchase = PurchaseModel();
  if (!Purchase) return { rows: [], total: 0, page: 1, pages: 1, pageSize };

  const and = [OUTSTANDING_QUERY];

  if (supplierId != null && supplierId !== '') {
    const sid = Number(supplierId);
    if (Number.isFinite(sid)) and.push({ SupplierId: sid });
  }

  const term = String(search || '').trim().slice(0, 100);
  if (term) {
    // Escape so the term is matched literally, not as a pattern (ReDoS-safe).
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    const asNum = Number(term);
    const or = [{ SupplierName: rx }, { SupplierReference: rx }];
    if (Number.isFinite(asNum)) or.push({ Number: asNum });
    and.push({ $or: or });
  }

  const dateRange = {};
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) dateRange.$gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      dateRange.$lte = d;
    }
  }
  if (Object.keys(dateRange).length) and.push({ IssuedDate: dateRange });

  const query = and.length === 1 ? and[0] : { $and: and };
  const size = clampPageSize(pageSize);
  const p = Math.max(1, Number(page) || 1);

  const [total, docs] = await Promise.all([
    Purchase.countDocuments(query),
    Purchase.find(query)
      .select('Id Number SupplierId SupplierCode SupplierName SupplierReference IssuedDate DueDate GrossAmount TotalPaidAmount DueAmount OverdueDays Status')
      .sort({ IssuedDate: -1, Number: -1 })
      .skip((p - 1) * size)
      .limit(size)
      .lean(),
  ]);

  const rows = docs.map((d) => ({ ...d, outstanding: outstandingAmount(d) }));
  return { rows, total, page: p, pages: Math.max(1, Math.ceil(total / size)), pageSize: size };
}

/** Live single-purchase read from KashFlow (authoritative). Returns null on 404. */
export async function fetchLivePurchase(number) {
  const url = `${KF_BASE()}/purchases/${encodeURIComponent(number)}`;
  return kfSession.withKfAuth(async (token) => {
    try {
      const resp = await kfAxios.get(url, {
        headers: { Accept: 'application/json', Authorization: `KfToken ${token}` },
        timeout: 20000,
      });
      return resp.data || null;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  });
}

/**
 * Re-verify a set of requested line payments against the live KashFlow ledger.
 *
 * @param {Array<{number:number, amount:number}>} items
 * @returns {Promise<{lines:Array, total:number, ok:boolean, blocking:number}>}
 *   Each line carries the live snapshot plus `ok`/`problem`. A line is blocking
 *   when the purchase is gone, fully settled, or the requested amount exceeds
 *   what is now due. Non-blocking lines are safe to pay.
 */
export async function reverify(items = []) {
  const lines = [];
  for (const raw of items) {
    const number = Number(raw?.number);
    const amount = money(raw?.amount);
    const line = {
      number,
      requestedAmount: amount,
      Id: null,
      supplierName: '',
      supplierId: null,
      supplierCode: '',
      supplierReference: '',
      issuedDate: null,
      liveDueAmount: null,
      liveGrossAmount: null,
      liveStatus: null,
      ok: false,
      problem: null,
    };

    if (!Number.isFinite(number)) {
      line.problem = 'Invalid purchase number.';
      lines.push(line);
      continue;
    }
    if (!(amount > 0)) {
      line.problem = 'Amount must be greater than zero.';
      lines.push(line);
      continue;
    }

    let live;
    try {
      live = await fetchLivePurchase(number);
    } catch (e) {
      line.problem = `Could not read purchase ${number} from KashFlow: ${e.message}`;
      lines.push(line);
      continue;
    }
    if (!live) {
      line.problem = `Purchase ${number} no longer exists in KashFlow.`;
      lines.push(line);
      continue;
    }

    const due = outstandingAmount(live);
    line.Id = live.Id ?? null;
    line.supplierName = live.SupplierName || '';
    line.supplierId = live.SupplierId ?? null;
    line.supplierCode = live.SupplierCode || '';
    line.supplierReference = live.SupplierReference || '';
    line.issuedDate = live.IssuedDate || null;
    line.liveDueAmount = due;
    line.liveGrossAmount = money(live.GrossAmount || 0);
    line.liveStatus = live.Status || null;

    if (!(due > 0)) {
      line.problem = `Purchase ${number} is already settled in KashFlow (nothing due).`;
    } else if (amount > due + 0.005) {
      line.problem = `Amount ${amount.toFixed(2)} exceeds the ${due.toFixed(2)} now due on purchase ${number}.`;
    } else {
      line.ok = true;
    }
    lines.push(line);
  }

  const payable = lines.filter((l) => l.ok);
  return {
    lines,
    total: money(payable.reduce((s, l) => s + l.requestedAmount, 0)),
    blocking: lines.length - payable.length,
    ok: payable.length > 0 && lines.every((l) => l.ok),
  };
}

/**
 * Create the bulk payment in KashFlow (BulkPayment_Create).
 * Only the supplied (already re-verified) lines are sent.
 *
 * @param {{accountId:number, date:string, method:number, comment?:string,
 *          lines:Array<{number:number, Id:number|null, requestedAmount:number,
 *          supplierName?:string, supplierCode?:string, supplierId?:number|null}>}} args
 * @returns {Promise<{ok:boolean, bulkPaymentNumber:number|null, raw:any}>}
 */
export async function createBulkPayment({ accountId, date, method, comment, lines }) {
  const paymentItems = (lines || []).map((l) => {
    const item = {
      Amount: money(l.requestedAmount),
      PaidDate: date,
      ObjectNumber: Number(l.number),
    };
    if (l.Id != null) item.Id = Number(l.Id);
    if (l.supplierId != null) item.ContactId = Number(l.supplierId);
    if (l.supplierCode) item.ContactCode = l.supplierCode;
    if (l.supplierName) item.ContactName = l.supplierName;
    return item;
  });

  const payload = {
    Date: date,
    AccountId: Number(accountId),
    Method: Number(method),
    PaymentItems: paymentItems,
  };
  if (comment) payload.Comment = String(comment).slice(0, 500);

  const url = `${KF_BASE()}/purchases/bulk/payments`;
  const resp = await kfSession.withKfAuth(async (token) =>
    kfAxios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `KfToken ${token}`,
        'User-Agent': `sms-app/${process.env.npm_package_version || '0.0.0'}`,
      },
      timeout: 30000,
    }),
  );

  const data = resp?.data || {};
  const bulkPaymentNumber =
    data.Number ?? data.BulkPaymentNumber ?? data.BulkId ?? data.number ?? null;
  return { ok: true, bulkPaymentNumber, raw: data, payload };
}

/**
 * Best-effort re-sync of the purchases just paid, so the outstanding list and
 * bank reconciliation reflect the payment without waiting for the next hcs-sync
 * run. Failures are swallowed — sync is the backstop.
 */
export async function refetchPurchases(numbers = []) {
  const Purchase = PurchaseModel();
  if (!Purchase) return { updated: 0 };
  let updated = 0;
  for (const number of numbers) {
    try {
      const live = await fetchLivePurchase(number);
      if (!live || live.Number == null) continue;
      await Purchase.updateOne(
        { Number: live.Number },
        { $set: { ...live, syncedAt: new Date() } },
        { upsert: true },
      );
      updated += 1;
    } catch (e) {
      logger.warn(`[bulkPay] refetch of purchase ${number} failed: ${e.message}`);
    }
  }
  return { updated };
}

export default {
  outstandingAmount,
  listBankAccounts,
  paymentSuggestions,
  listOutstandingSuppliers,
  clampPageSize,
  listOutstanding,
  fetchLivePurchase,
  reverify,
  createBulkPayment,
  refetchPurchases,
};
