import mdb from './mongooseDatabaseService.js';
import { classify, buildMatchFromLink, signedAmount, LIVE_BANK_LINE } from './bankLinkService.js';

/**
 * Reads for the reconciliation UI: the per-account worklist, the account
 * summary, and generating suggestions from KashFlow's own links.
 *
 * Everything here is read-only against the REST namespace. The only writes are
 * `suggested` bankMatch rows, which are proposals — a person still confirms
 * them through bankReconciliationService.
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function models() {
  return {
    BankTransaction: mdb.REST?.bankTransaction || null,
    BankAccount: mdb.REST?.bankAccount || null,
    BankMatch: mdb.INTERNAL?.bankMatch || null,
    BankSignOff: mdb.INTERNAL?.bankSignOff || null,
  };
}

/** Clamp a user-supplied page size. */
export function clampPageSize(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, 1), MAX_PAGE_SIZE);
}

/** Escape a user string before it reaches a Mongo regex. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bank accounts, with the reconciliation state of each.
 *
 * Six account ids in the live data appear on transactions but have no
 * bankaccounts document — accounts deleted in KashFlow whose history remains.
 * They are surfaced as "Unknown account" rather than dropped, because their
 * transactions are real and still need accounting for.
 */
export async function listAccounts() {
  const { BankTransaction, BankAccount, BankMatch } = models();
  if (!BankTransaction) return [];

  const [accounts, txAgg, confirmedAgg] = await Promise.all([
    BankAccount ? BankAccount.find({}).select('Id AccountName IsArchived BankBalance ReconcileDate').lean() : [],
    BankTransaction.aggregate([
      { $match: { ...LIVE_BANK_LINE } },
      { $group: { _id: '$AccountId', total: { $sum: 1 }, oldest: { $min: '$Date' }, newest: { $max: '$Date' } } },
    ]),
    BankMatch
      ? BankMatch.aggregate([
        { $match: { status: 'confirmed', deletedAt: null } },
        { $group: { _id: '$accountId', confirmed: { $sum: 1 } } },
      ])
      : [],
  ]);

  const byId = new Map(accounts.map(a => [a.Id, a]));
  const confirmedById = new Map(confirmedAgg.map(r => [r._id, r.confirmed]));

  return txAgg
    .map((row) => {
      const account = byId.get(row._id);
      const confirmed = confirmedById.get(row._id) || 0;
      return {
        accountId: row._id,
        accountName: account?.AccountName || 'Unknown account',
        known: Boolean(account),
        isArchived: Boolean(account?.IsArchived),
        bankBalance: account?.BankBalance ?? null,
        transactionCount: row.total,
        confirmedCount: confirmed,
        outstandingCount: Math.max(row.total - confirmed, 0),
        progress: row.total ? Math.round((confirmed / row.total) * 100) : 0,
        oldest: row.oldest || null,
        newest: row.newest || null,
      };
    })
    .sort((a, b) => b.transactionCount - a.transactionCount);
}

/**
 * One account's worklist: bank lines joined to whatever match state exists.
 *
 * The join is done in application code rather than an aggregation $lookup
 * because the two collections live in different databases on different
 * connections (REST vs INTERNAL) — a $lookup cannot cross that boundary.
 */
export async function getWorklist({
  accountId,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  state = 'outstanding',
  search = '',
  from = null,
  to = null,
  entity = '',
} = {}) {
  const { BankTransaction, BankMatch } = models();
  if (!BankTransaction) return { rows: [], total: 0, page: 1, pageSize, pageCount: 0 };

  const size = clampPageSize(pageSize);
  const current = Math.max(parseInt(page, 10) || 1, 1);

  const query = { AccountId: Number(accountId), ...LIVE_BANK_LINE };

  if (from || to) {
    query.Date = {};
    if (from) query.Date.$gte = new Date(from);
    if (to) {
      // Inclusive of the whole end day.
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      query.Date.$lte = end;
    }
  }

  if (entity) query.EntityName = entity;

  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const asNumber = Number(search);
    query.$or = [
      { Comment: rx },
      { Type: rx },
      { SupplierName: rx },
      { CustomerName: rx },
      ...(Number.isFinite(asNumber) ? [{ ResourceNumber: asNumber }, { Id: asNumber }] : []),
    ];
  }

  // State filtering needs the match side, so candidate ids are gathered first.
  let stateFilterIds = null;
  if (BankMatch && state && state !== 'all') {
    const statusFor = {
      outstanding: { $in: ['suggested'] },
      confirmed: 'confirmed',
      rejected: 'rejected',
    }[state];

    if (state === 'unmatched') {
      // Lines with no match record at all.
      const claimed = await BankMatch.distinct('bankLines.bankTransactionId', { deletedAt: null });
      query.Id = { $nin: claimed.filter(v => v != null) };
    } else if (statusFor) {
      stateFilterIds = await BankMatch.distinct('bankLines.bankTransactionId', {
        status: statusFor, deletedAt: null,
      });
      query.Id = { $in: stateFilterIds.filter(v => v != null) };
    }
  }

  const [total, lines] = await Promise.all([
    BankTransaction.countDocuments(query),
    BankTransaction.find(query)
      .sort({ Date: -1, Id: -1 })
      .skip((current - 1) * size)
      .limit(size)
      .select('Id AccountId Date EntityName ResourceNumber PaidIn PaidOut Comment Type SupplierName CustomerName Reconciled syncedAt updatedAt')
      .lean(),
  ]);

  // Attach match state for just this page.
  const ids = lines.map(l => l.Id);
  const matches = BankMatch
    ? await BankMatch.find({ 'bankLines.bankTransactionId': { $in: ids }, deletedAt: null })
      .select('uuid status integrity confidence matchType documents totals reasons origin reviewedByName reviewedAt bankLines.bankTransactionId')
      .lean()
    : [];

  const matchByBankId = new Map();
  for (const m of matches) {
    for (const line of m.bankLines || []) {
      // A confirmed match wins over a rejected or superseded one for display.
      const existing = matchByBankId.get(line.bankTransactionId);
      if (!existing || (existing.status !== 'confirmed' && m.status === 'confirmed')) {
        matchByBankId.set(line.bankTransactionId, m);
      }
    }
  }

  const rows = lines.map((line) => ({
    ...line,
    amount: signedAmount(line),
    strategy: classify(line).strategy,
    match: matchByBankId.get(line.Id) || null,
  }));

  return {
    rows,
    total,
    page: current,
    pageSize: size,
    pageCount: Math.max(Math.ceil(total / size), 1),
  };
}

/**
 * Generate `suggested` matches from KashFlow's own links for one account.
 *
 * Idempotent: a bank line that already has any match record is skipped
 * entirely. Re-running must not churn bankMatch, because every write is
 * audited by auditPlugin and a re-scoring loop would flood the audit log.
 */
export async function generateSuggestions({ accountId = null, limit = 5000 } = {}) {
  const { BankTransaction, BankMatch } = models();
  if (!BankTransaction || !BankMatch) {
    return { examined: 0, created: 0, skipped: 0, unresolved: 0, unlinked: 0 };
  }

  const query = { ...LIVE_BANK_LINE };
  if (accountId != null) query.AccountId = Number(accountId);

  // Only the linked kinds are this service's business; the rest belong to the
  // rules engine and the matcher.
  query.EntityName = { $in: ['purchase', 'invoice', 'purchasebatchpayment', 'invoicebatchpayment', 'journal'] };

  const claimed = (await BankMatch.distinct('bankLines.bankTransactionId', { deletedAt: null }))
    .filter(v => v != null);

  // Excluded in the QUERY, not after fetching. Filtering afterwards makes the
  // limit apply to already-processed lines, so every run re-reads the same
  // newest `limit` rows and the older backlog is never reached — which is
  // exactly what happened on the first production run: 13,429 lines, a 5,000
  // limit, and precisely 5,000 suggestions that would never have grown.
  if (claimed.length) query.Id = { $nin: claimed };

  const lines = await BankTransaction.find(query)
    .sort({ Date: -1 })
    .limit(limit)
    .select('Id AccountId Date EntityName ResourceNumber PaidIn PaidOut Comment Type')
    .lean();

  const stats = { examined: lines.length, created: 0, skipped: 0, unresolved: 0, unlinked: 0 };
  const pending = [];

  for (const line of lines) {
    const payload = await buildMatchFromLink(line);
    if (!payload) { stats.unresolved += 1; continue; }

    pending.push(payload);
  }

  if (pending.length) {
    // insertMany rather than a loop: one audit entry per document either way,
    // but a single round trip.
    const created = await BankMatch.insertMany(pending, { ordered: false });
    stats.created = created.length;
  }

  return stats;
}

/** Counts for the module dashboard. */
export async function getOverview() {
  const { BankTransaction, BankMatch, BankSignOff } = models();
  if (!BankTransaction) {
    return { accounts: [], totals: { transactions: 0, confirmed: 0, suggested: 0, outstanding: 0, drifted: 0 }, recentSignOffs: [] };
  }

  const [accounts, transactions, byStatus, drifted, recentSignOffs] = await Promise.all([
    listAccounts(),
    BankTransaction.countDocuments({ ...LIVE_BANK_LINE }),
    BankMatch
      ? BankMatch.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      : [],
    BankMatch ? BankMatch.countDocuments({ status: 'confirmed', integrity: { $ne: 'ok' }, deletedAt: null }) : 0,
    BankSignOff
      ? BankSignOff.find({ deletedAt: null }).sort({ signedAt: -1 }).limit(5)
        .select('uuid accountId accountName periodStart periodEnd status signedByName signedAt variance').lean()
      : [],
  ]);

  const counts = Object.fromEntries(byStatus.map(r => [r._id, r.n]));
  const confirmed = counts.confirmed || 0;
  const suggested = counts.suggested || 0;

  return {
    accounts,
    totals: {
      transactions,
      confirmed,
      suggested,
      rejected: counts.rejected || 0,
      outstanding: Math.max(transactions - confirmed, 0),
      drifted,
      progress: transactions ? Math.round((confirmed / transactions) * 100) : 0,
    },
    recentSignOffs,
  };
}

export default {
  listAccounts,
  getWorklist,
  generateSuggestions,
  getOverview,
  clampPageSize,
};
