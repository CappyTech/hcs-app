#!/usr/bin/env node
/**
 * One-off migration: stamp `bankAccountId` and `bankLineKey` onto every stored
 * bank line, in `bankmatches` and `statementlines`.
 *
 * ORDER MATTERS. Run this BEFORE deploying hcs-sync 0.11.0.
 *
 * Both collections reference a bank line by a bare numeric KashFlow Id.
 * hcs-schemas 3.0.0 re-keys `banktransactions` on (AccountId, Id) so that both
 * halves of an internal transfer are stored — KashFlow returns one transaction
 * in both accounts' feeds, each from that account's point of view — and from
 * that moment an Id no longer resolves to one line. This backfill is only
 * unambiguous while it still does: today there is exactly one document per Id,
 * so the account each existing match refers to can be read off directly. Run it
 * afterwards and the halves have already appeared, with nothing to say which
 * one a pre-existing match meant.
 *
 * Idempotent, and safe to run repeatedly: rows that already carry a key are
 * skipped. Nothing is deleted and no bank transaction is touched. KashFlow is
 * never contacted.
 *
 * Usage:
 *   node scripts/backfill-bank-line-keys.js --dry-run
 *   node scripts/backfill-bank-line-keys.js
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import { bankLineKey } from '../mongoose/services/bankLinkService.js';

const DRY_RUN = process.argv.includes('--dry-run');

function log(...args) {
  console.log(DRY_RUN ? '[dry-run]' : '[backfill]', ...args);
}

async function main() {
  await mdb.connect();

  const BankTransaction = mdb.REST?.bankTransaction;
  const BankMatch = mdb.INTERNAL?.bankMatch;
  const StatementLine = mdb.INTERNAL?.statementLine;
  if (!BankTransaction || !BankMatch) throw new Error('bank models not loaded');

  // Guard: if any Id already resolves to more than one document, the sync has
  // already re-keyed and this backfill can no longer tell the halves apart.
  const dupes = await BankTransaction.aggregate([
    { $group: { _id: '$Id', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'ids' },
  ]);
  if (dupes[0]?.ids) {
    throw new Error(
      `${dupes[0].ids} KashFlow Ids already have more than one document. `
      + 'hcs-sync 0.11.0 has already run, so which half an existing match meant '
      + 'is no longer recoverable from the data. Restore bankmatches from a '
      + 'backup taken before that deploy and run this first.',
    );
  }

  // Id -> AccountId for every bank line, deleted ones included: a match may
  // legitimately point at a soft-deleted transaction, and the exceptions report
  // depends on still being able to resolve it.
  const accountById = new Map(
    (await BankTransaction.find({}).select('Id AccountId').lean())
      .map(t => [t.Id, t.AccountId]),
  );
  log(`resolved ${accountById.size.toLocaleString('en-GB')} bank transactions`);

  /* ── bankmatches ─────────────────────────────────────────────────── */

  const matches = await BankMatch.find({ 'bankLines.0': { $exists: true } })
    .select('uuid bankLines.bankTransactionId bankLines.bankAccountId bankLines.bankLineKey')
    .lean();

  let matchesUpdated = 0;
  let linesStamped = 0;
  let unresolved = 0;

  for (const m of matches) {
    const updates = {};
    (m.bankLines || []).forEach((line, i) => {
      if (line.bankLineKey) return;
      const accountId = line.bankAccountId ?? accountById.get(line.bankTransactionId);
      if (accountId == null) {
        // The transaction is gone from the mirror entirely. Left null rather
        // than guessed: a wrong key would claim a line this match never meant.
        unresolved += 1;
        return;
      }
      const key = bankLineKey({ bankAccountId: accountId, bankTransactionId: line.bankTransactionId });
      if (!key) { unresolved += 1; return; }
      updates[`bankLines.${i}.bankAccountId`] = accountId;
      updates[`bankLines.${i}.bankLineKey`] = key;
      linesStamped += 1;
    });

    if (!Object.keys(updates).length) continue;
    matchesUpdated += 1;
    // updateOne with a positional path, not save(): this must not fire the
    // audit plugin's change tracking for what is a migration, not a decision.
    if (!DRY_RUN) await BankMatch.collection.updateOne({ uuid: m.uuid }, { $set: updates });
  }

  log(`bankmatches: ${matchesUpdated.toLocaleString('en-GB')} documents, `
    + `${linesStamped.toLocaleString('en-GB')} lines stamped, ${unresolved} unresolved`);

  /* ── statementlines ──────────────────────────────────────────────── */

  let stmtUpdated = 0;
  let stmtUnresolved = 0;
  if (StatementLine) {
    const lines = await StatementLine.find({
      matchedBankTransactionId: { $ne: null },
      matchedBankAccountId: null,
    }).select('_id matchedBankTransactionId').lean();

    for (const l of lines) {
      const accountId = accountById.get(l.matchedBankTransactionId);
      if (accountId == null) { stmtUnresolved += 1; continue; }
      stmtUpdated += 1;
      if (!DRY_RUN) {
        await StatementLine.collection.updateOne(
          { _id: l._id },
          { $set: { matchedBankAccountId: accountId } },
        );
      }
    }
  }
  log(`statementlines: ${stmtUpdated.toLocaleString('en-GB')} stamped, ${stmtUnresolved} unresolved`);

  if (unresolved || stmtUnresolved) {
    log('unresolved rows point at a bank transaction no longer in the mirror; '
      + 'they keep a null key and are reported by /bank/exceptions.');
  }
  if (DRY_RUN) log('nothing was written.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] failed:', err.message);
    process.exit(1);
  });
