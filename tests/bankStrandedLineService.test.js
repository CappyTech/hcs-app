import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import { reconcileStrandedLines } from '../mongoose/services/bankStrandedLineService.js';

/*
 * The service reads mdb lazily, so plain fakes are enough — no database.
 *
 * `txs` is the whole banktransactions collection. The fake `find` interprets
 * only the two filter shapes the service actually issues, which keeps the test
 * honest about what is being queried rather than what is convenient.
 */
function fakeChain(rows) {
  const chain = { select: () => chain, lean: () => Promise.resolve(rows) };
  return chain;
}

function patchMdb({ accounts = [], txs = [], matchCount = 0, statementCount = 0 } = {}) {
  const updateMany = mock.fn(() => Promise.resolve({ modifiedCount: matchCount }));
  const stmtUpdateMany = mock.fn(() => Promise.resolve({ modifiedCount: statementCount }));
  const updateOne = mock.fn(() => Promise.resolve({ modifiedCount: 1 }));

  mdb.REST = {
    bankAccount: { find: mock.fn(() => fakeChain(accounts.map(Id => ({ Id })))) },
    bankTransaction: {
      find: mock.fn((q) => {
        const listed = q.AccountId?.$in;
        const notListed = q.AccountId?.$nin;
        if (notListed) return fakeChain(txs.filter(t => !notListed.includes(t.AccountId)));
        return fakeChain(txs.filter(t => listed.includes(t.AccountId) && q.Id.$in.includes(t.Id)));
      }),
      collection: { updateOne },
    },
  };
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    bankMatch: { collection: { updateMany }, countDocuments: mock.fn(() => Promise.resolve(matchCount)) },
    statementLine: {
      collection: { updateMany: stmtUpdateMany },
      countDocuments: mock.fn(() => Promise.resolve(statementCount)),
    },
  };
  return { updateMany, stmtUpdateMany, updateOne };
}

describe('bankStrandedLineService', () => {
  beforeEach(() => patchMdb());

  it('retires a stranded row once its replacement exists', async () => {
    const { updateOne, updateMany } = patchMdb({
      accounts: [611594, 938298],
      txs: [
        { Id: 500, AccountId: 851475 },  // stranded: account KashFlow no longer lists
        { Id: 500, AccountId: 611594 },  // the replacement, written by the feed
      ],
      matchCount: 1,
    });

    const stats = await reconcileStrandedLines();

    assert.equal(stats.retired, 1);
    assert.equal(stats.matchLinesMoved, 1);
    assert.equal(stats.noReplacement, 0);

    // The match moves onto the replacement's key, not merely off the old one.
    const [, update, opts] = updateMany.mock.calls[0].arguments;
    assert.equal(update.$set['bankLines.$[l].bankLineKey'], '611594:500');
    assert.equal(update.$set['bankLines.$[l].bankAccountId'], 611594);
    assert.deepEqual(opts.arrayFilters, [{ 'l.bankLineKey': '851475:500' }]);

    // Soft-deleted, never removed, and scoped to the stranded row alone.
    const [filter, txUpdate] = updateOne.mock.calls[0].arguments;
    assert.deepEqual(filter, { AccountId: 851475, Id: 500 });
    assert.ok(txUpdate.$set.deletedAt instanceof Date);
    assert.equal(txUpdate.$set.supersededBy, '611594:500');
  });

  it('leaves a row alone when nothing replaced it', async () => {
    // An archived account's line that KashFlow simply stopped returning is real
    // history. Retiring it because its account is no longer listed would delete
    // data on the strength of an account list.
    const { updateOne } = patchMdb({
      accounts: [611594],
      txs: [{ Id: 700, AccountId: 851475 }],
    });

    const stats = await reconcileStrandedLines();

    assert.equal(stats.retired, 0);
    assert.equal(stats.noReplacement, 1);
    assert.equal(updateOne.mock.calls.length, 0);
  });

  it('refuses to choose when an Id exists on two listed accounts', async () => {
    // Two listed accounts sharing an Id is a transfer — both halves are real
    // ledger lines, and neither is "the" replacement for a third row.
    const { updateOne } = patchMdb({
      accounts: [611594, 938298],
      txs: [
        { Id: 800, AccountId: 851475 },
        { Id: 800, AccountId: 611594 },
        { Id: 800, AccountId: 938298 },
      ],
    });

    const stats = await reconcileStrandedLines();

    assert.equal(stats.retired, 0);
    assert.equal(stats.noReplacement, 1);
    assert.equal(updateOne.mock.calls.length, 0);
  });

  it('does nothing at all when the account list is empty', async () => {
    // With no account list every row looks stranded. Failing closed is the only
    // safe reading, since the alternative retires the entire collection.
    const { updateOne } = patchMdb({
      accounts: [],
      txs: [{ Id: 900, AccountId: 611594 }, { Id: 900, AccountId: 851475 }],
    });

    const stats = await reconcileStrandedLines();

    assert.equal(stats.examined, 0);
    assert.equal(stats.retired, 0);
    assert.equal(updateOne.mock.calls.length, 0);
  });

  it('writes nothing on a dry run but still reports what it would move', async () => {
    const { updateOne, updateMany } = patchMdb({
      accounts: [611594],
      txs: [{ Id: 500, AccountId: 851475 }, { Id: 500, AccountId: 611594 }],
      matchCount: 3,
    });

    const stats = await reconcileStrandedLines({ dryRun: true });

    assert.equal(stats.retired, 1);
    assert.equal(stats.matchLinesMoved, 3);
    assert.equal(updateOne.mock.calls.length, 0);
    assert.equal(updateMany.mock.calls.length, 0);
  });

  it('is a no-op once nothing is stranded, so it can run on a schedule', async () => {
    const { updateOne } = patchMdb({
      accounts: [611594, 938298],
      txs: [{ Id: 500, AccountId: 611594 }, { Id: 500, AccountId: 938298 }],
    });

    const stats = await reconcileStrandedLines();

    assert.equal(stats.examined, 0);
    assert.equal(stats.retired, 0);
    assert.equal(updateOne.mock.calls.length, 0);
  });
});
