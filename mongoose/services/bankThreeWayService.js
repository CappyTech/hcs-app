import mdb from './mongooseDatabaseService.js';
import { signedAmount, LIVE_BANK_LINE } from './bankLinkService.js';

/**
 * Three-way matching: statement line ↔ bank transaction ↔ document.
 *
 * The bank's own record of what moved, KashFlow's record of it, and the
 * invoice or purchase it settled. The first leg is what this file adds; the
 * second is bankLinkService.
 *
 * The point is the gaps, and the one that matters most is a statement line
 * with no bank transaction: money that actually left or entered the account
 * and was never booked. Reconciling KashFlow against itself cannot find that,
 * because it is absent from both sides of that comparison.
 *
 * Two rules keep this honest:
 *
 *   1. Only statements whose running balance verified are used. A parse that
 *      failed its balance chain may have wrong amounts, and a wrong amount
 *      here manufactures a discrepancy that will be chased for hours.
 *
 *   2. Gaps are only reported inside periods a statement actually covers.
 *      Otherwise every bank transaction outside the imported range looks
 *      unmatched, and the report is noise. This is the difference between a
 *      finding and a false alarm.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 3;

const pence = (v) => Math.round((Number(v) || 0) * 100);

function models() {
  return {
    BankTransaction: mdb.REST?.bankTransaction || null,
    StatementImport: mdb.INTERNAL?.statementImport || null,
    StatementLine: mdb.INTERNAL?.statementLine || null,
  };
}

/**
 * Date ranges, per account, that a trusted statement covers.
 *
 * Only imports with status 'parsed' count — see rule 1 above. Overlapping
 * ranges are merged so an account statemented monthly reads as one span
 * rather than twelve.
 */
export async function coveredPeriods(accountId = null) {
  const { StatementImport } = models();
  if (!StatementImport) return [];

  const query = { status: 'parsed', balanceChainOk: true, deletedAt: null };
  if (accountId != null) query.accountId = Number(accountId);

  const imports = await StatementImport.find(query)
    .select('accountId periodStart periodEnd').sort({ accountId: 1, periodStart: 1 }).lean();

  const byAccount = new Map();
  for (const imp of imports) {
    if (!imp.periodStart || !imp.periodEnd) continue;
    if (!byAccount.has(imp.accountId)) byAccount.set(imp.accountId, []);
    byAccount.get(imp.accountId).push({ start: new Date(imp.periodStart), end: new Date(imp.periodEnd) });
  }

  const out = [];
  for (const [id, ranges] of byAccount) {
    ranges.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      // Touching or overlapping ranges join; a one-day gap between statements
      // is a boundary, not a hole worth reporting.
      if (last && r.start.getTime() <= last.end.getTime() + DAY_MS) {
        if (r.end > last.end) last.end = r.end;
      } else {
        merged.push({ start: r.start, end: r.end });
      }
    }
    out.push({ accountId: id, ranges: merged });
  }
  return out;
}

const inAnyRange = (date, ranges) => {
  const t = new Date(date).getTime();
  return ranges.some(r => t >= r.start.getTime() && t <= r.end.getTime());
};

/**
 * Pair statement lines to bank transactions.
 *
 * Pure, so the pairing rules are testable without a database. A pair needs the
 * same account, the same amount to the penny, and dates within `windowDays` —
 * a bank and a bookkeeper routinely date the same movement differently.
 *
 * Each side is used at most once. Where several fit, the closest by date wins,
 * then the lowest id, so the outcome does not depend on input order.
 */
export function pairLines(statementLines, bankTransactions, { windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const byAmount = new Map();
  for (const tx of bankTransactions) {
    const key = `${tx.AccountId}|${pence(signedAmount(tx))}`;
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(tx);
  }

  const usedTx = new Set();
  const pairs = [];
  const unmatchedStatement = [];

  // Sorted so the result is stable regardless of how the caller ordered them.
  const ordered = [...statementLines].sort(
    (a, b) => new Date(a.date) - new Date(b.date) || String(a.uuid).localeCompare(String(b.uuid)),
  );

  for (const line of ordered) {
    const key = `${line.accountId}|${pence(line.amount)}`;
    const lineTime = new Date(line.date).getTime();

    const candidates = (byAmount.get(key) || [])
      .filter(tx => !usedTx.has(tx.Id)
        && Math.abs(new Date(tx.Date).getTime() - lineTime) <= windowDays * DAY_MS)
      .sort((a, b) => {
        const da = Math.abs(new Date(a.Date).getTime() - lineTime);
        const db = Math.abs(new Date(b.Date).getTime() - lineTime);
        return da - db || a.Id - b.Id;
      });

    if (!candidates.length) { unmatchedStatement.push(line); continue; }

    const tx = candidates[0];
    usedTx.add(tx.Id);
    pairs.push({
      line,
      transaction: tx,
      dayGap: Math.round(Math.abs(new Date(tx.Date).getTime() - lineTime) / DAY_MS),
    });
  }

  const unmatchedBank = bankTransactions.filter(tx => !usedTx.has(tx.Id));
  return { pairs, unmatchedStatement, unmatchedBank };
}

/**
 * Reconcile statement lines against bank transactions and record the outcome.
 *
 * Writes only to statementLine (its match state). Bank transactions and
 * KashFlow are untouched.
 */
export async function reconcileStatements({ accountId = null, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const { BankTransaction, StatementLine } = models();
  if (!BankTransaction || !StatementLine) {
    return { accounts: 0, paired: 0, statementOnly: 0, bankOnly: 0, periods: [] };
  }

  const covered = await coveredPeriods(accountId);
  if (!covered.length) return { accounts: 0, paired: 0, statementOnly: 0, bankOnly: 0, periods: [] };

  const totals = { accounts: covered.length, paired: 0, statementOnly: 0, bankOnly: 0, periods: [] };

  for (const { accountId: id, ranges } of covered) {
    const from = new Date(Math.min(...ranges.map(r => r.start.getTime())));
    const to = new Date(Math.max(...ranges.map(r => r.end.getTime())));

    const [lines, transactions] = await Promise.all([
      StatementLine.find({ accountId: id, date: { $gte: from, $lte: to }, deletedAt: null }).lean(),
      BankTransaction.find({
        AccountId: id,
        // Widened by the pairing window so a transaction dated just outside a
        // statement's range can still pair with a line inside it.
        Date: { $gte: new Date(from.getTime() - windowDays * DAY_MS), $lte: new Date(to.getTime() + windowDays * DAY_MS) },
        ...LIVE_BANK_LINE,
      }).select('Id AccountId Date Comment Type PaidIn PaidOut EntityName ResourceNumber').lean(),
    ]);

    const { pairs, unmatchedStatement, unmatchedBank } = pairLines(lines, transactions, { windowDays });

    // Only bank transactions dated inside a covered range count as missing
    // from the statement; the widened fetch above deliberately reaches past it.
    const bankOnlyInRange = unmatchedBank.filter(tx => inAnyRange(tx.Date, ranges));

    if (pairs.length) {
      await StatementLine.bulkWrite(pairs.map(p => ({
        updateOne: {
          filter: { _id: p.line._id },
          update: {
            $set: {
              matchedBankTransactionId: p.transaction.Id,
              matchedBankAccountId: p.transaction.AccountId ?? null,
              matchedAt: new Date(),
              matchConfidence: p.dayGap === 0 ? 100 : Math.max(60, 100 - p.dayGap * 10),
              status: 'matched',
            },
          },
        },
      })), { ordered: false });
    }

    // A line that no longer pairs must not keep a stale match.
    const unmatchedIds = unmatchedStatement.map(l => l._id);
    if (unmatchedIds.length) {
      await StatementLine.updateMany(
        { _id: { $in: unmatchedIds }, status: { $ne: 'ignored' } },
        { $set: { status: 'unmatched', matchedBankTransactionId: null, matchedBankAccountId: null, matchedAt: null, matchConfidence: 0 } },
      );
    }

    totals.paired += pairs.length;
    totals.statementOnly += unmatchedStatement.length;
    totals.bankOnly += bankOnlyInRange.length;
    totals.periods.push({
      accountId: id,
      from,
      to,
      paired: pairs.length,
      statementOnly: unmatchedStatement.length,
      bankOnly: bankOnlyInRange.length,
    });
  }

  return totals;
}

/**
 * The gaps, for the exceptions page.
 *
 * statementOnly is the finding worth acting on: the bank says money moved and
 * KashFlow has no record of it. bankOnly is the inverse — booked but not on
 * the statement — which is usually a timing difference at a period boundary
 * and occasionally something that never actually cleared.
 */
export async function findDiscrepancies({ accountId = null, windowDays = DEFAULT_WINDOW_DAYS, limit = 200 } = {}) {
  const { BankTransaction, StatementLine } = models();
  if (!BankTransaction || !StatementLine) {
    return { covered: [], statementOnly: [], bankOnly: [], hasStatements: false };
  }

  const covered = await coveredPeriods(accountId);
  if (!covered.length) return { covered: [], statementOnly: [], bankOnly: [], hasStatements: false };

  const statementOnly = [];
  const bankOnly = [];

  for (const { accountId: id, ranges } of covered) {
    const from = new Date(Math.min(...ranges.map(r => r.start.getTime())));
    const to = new Date(Math.max(...ranges.map(r => r.end.getTime())));

    const [lines, transactions] = await Promise.all([
      StatementLine.find({ accountId: id, date: { $gte: from, $lte: to }, deletedAt: null }).lean(),
      BankTransaction.find({
        AccountId: id,
        Date: { $gte: new Date(from.getTime() - windowDays * DAY_MS), $lte: new Date(to.getTime() + windowDays * DAY_MS) },
        ...LIVE_BANK_LINE,
      }).select('Id AccountId Date Comment Type PaidIn PaidOut EntityName ResourceNumber').lean(),
    ]);

    const result = pairLines(lines, transactions, { windowDays });

    for (const line of result.unmatchedStatement.slice(0, limit)) {
      statementOnly.push({ accountId: id, line });
    }
    for (const tx of result.unmatchedBank.filter(t => inAnyRange(t.Date, ranges)).slice(0, limit)) {
      bankOnly.push({ accountId: id, transaction: { ...tx, amount: signedAmount(tx) } });
    }
  }

  return {
    covered,
    statementOnly: statementOnly.slice(0, limit),
    bankOnly: bankOnly.slice(0, limit),
    hasStatements: true,
  };
}

export default { coveredPeriods, pairLines, reconcileStatements, findDiscrepancies };
