import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { bankLineKey, LIVE_BANK_LINE } from './bankLinkService.js';

/**
 * Retires bank lines left behind by the (AccountId, Id) re-key.
 *
 * Before hcs-schemas 3.0.0 a bank transaction was stored under whatever
 * `AccountId` KashFlow put in the payload. That field does not name the ledger
 * the line belongs to — it names the account the transaction was entered
 * against — and for 105 rows here it names an account KashFlow no longer lists
 * at all, the far side of an inter-account transfer. Those rows still arrived
 * inside a *listed* account's feed.
 *
 * From hcs-sync 0.11.0 a row is stored under the account whose feed returned
 * it, which is the only authority on that. So each of those 105 rows is written
 * afresh under a listed account, and the original is left behind: no feed
 * writes to it, and the soft-delete sweep cannot reach it either, because the
 * sweep is scoped `{ AccountId: accountId, ... }` and no listed account matches.
 * It would sit in the worklist forever as a duplicate of the line that replaced
 * it, and the 37 matches pointing at it would reference a row nothing maintains.
 *
 * This finds those rows, moves any match or statement line onto the replacement,
 * and soft-deletes the original.
 *
 * Deliberately conservative:
 *
 *   - A stranded row is only retired when a replacement genuinely exists — same
 *     KashFlow Id, under an account KashFlow currently lists. A line on an
 *     archived account with no replacement is real history, not debris, and is
 *     left exactly as it is.
 *   - Soft-deleted, never removed. `deletedAt` is the idiom the sync already
 *     uses, LIVE_BANK_LINE already excludes it everywhere, and it is reversible.
 *     The sync un-deletes on re-upsert, but nothing re-upserts these, so it
 *     sticks.
 *   - Idempotent. Once a row is retired it no longer matches, so re-running is
 *     a no-op — which is what lets this be a scheduled job rather than a
 *     migration somebody has to remember to run at the right moment.
 */

function models() {
  return {
    BankTransaction: mdb.REST?.bankTransaction || null,
    BankAccount: mdb.REST?.bankAccount || null,
    BankMatch: mdb.INTERNAL?.bankMatch || null,
    StatementLine: mdb.INTERNAL?.statementLine || null,
  };
}

export async function reconcileStrandedLines({ dryRun = false } = {}) {
  const { BankTransaction, BankAccount, BankMatch, StatementLine } = models();
  const empty = { examined: 0, retired: 0, matchLinesMoved: 0, statementLinesMoved: 0, noReplacement: 0 };
  if (!BankTransaction || !BankAccount) return empty;

  const listed = (await BankAccount.find({}).select('Id').lean())
    .map(a => a.Id)
    .filter(v => v != null);
  // No account list means no way to tell a stranded row from a live one. Doing
  // nothing is the only safe reading of that.
  if (!listed.length) return empty;

  const stranded = await BankTransaction
    .find({ AccountId: { $nin: listed }, ...LIVE_BANK_LINE })
    .select('Id AccountId')
    .lean();
  if (!stranded.length) return empty;

  // The replacements: same Id, on an account KashFlow lists.
  const replacements = new Map();
  for (const r of await BankTransaction
    .find({ Id: { $in: stranded.map(s => s.Id) }, AccountId: { $in: listed }, ...LIVE_BANK_LINE })
    .select('Id AccountId')
    .lean()) {
    // An Id can legitimately exist on two listed accounts — that is a transfer,
    // and both halves are real. Neither is the replacement for a third row, so
    // an ambiguous Id is skipped rather than guessed at.
    if (replacements.has(r.Id)) replacements.set(r.Id, null);
    else replacements.set(r.Id, r.AccountId);
  }

  const stats = { ...empty, examined: stranded.length };

  for (const row of stranded) {
    const toAccount = replacements.get(row.Id);
    if (toAccount == null) { stats.noReplacement += 1; continue; }

    const fromKey = bankLineKey(row);
    const toKey = bankLineKey({ AccountId: toAccount, Id: row.Id });
    if (!fromKey || !toKey) { stats.noReplacement += 1; continue; }

    if (!dryRun) {
      // Positional update through the native driver: this is bookkeeping about
      // where a line lives, not a reconciliation decision, and it must not
      // appear in the audit log as though somebody re-matched something.
      const moved = await BankMatch?.collection.updateMany(
        { 'bankLines.bankLineKey': fromKey },
        {
          $set: {
            'bankLines.$[l].bankAccountId': toAccount,
            'bankLines.$[l].bankLineKey': toKey,
          },
        },
        { arrayFilters: [{ 'l.bankLineKey': fromKey }] },
      );
      stats.matchLinesMoved += moved?.modifiedCount || 0;

      const movedLines = await StatementLine?.collection.updateMany(
        { matchedBankTransactionId: row.Id, matchedBankAccountId: row.AccountId },
        { $set: { matchedBankAccountId: toAccount } },
      );
      stats.statementLinesMoved += movedLines?.modifiedCount || 0;

      await BankTransaction.collection.updateOne(
        { AccountId: row.AccountId, Id: row.Id },
        { $set: { deletedAt: new Date(), supersededBy: toKey } },
      );
    } else {
      stats.matchLinesMoved += await BankMatch?.countDocuments({ 'bankLines.bankLineKey': fromKey }) || 0;
      stats.statementLinesMoved += await StatementLine?.countDocuments({
        matchedBankTransactionId: row.Id, matchedBankAccountId: row.AccountId,
      }) || 0;
    }

    stats.retired += 1;
  }

  // Logged only when it acts. The scheduler keeps `lastResult` for /admin/jobs
  // but logs nothing on success, and this job soft-deletes rows and moves match
  // lines — that should leave a trace somewhere durable, not only in a UI panel.
  if (stats.retired > 0 && !dryRun) {
    logger.info(
      `[bank-stranded-lines] retired ${stats.retired} stranded bank line(s); `
      + `moved ${stats.matchLinesMoved} match line(s) and ${stats.statementLinesMoved} statement line(s)`,
    );
  }

  return stats;
}

export default { reconcileStrandedLines };
