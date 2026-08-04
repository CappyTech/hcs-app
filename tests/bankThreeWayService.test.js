import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import {
  pairLines,
  coveredPeriods,
  findDiscrepancies,
} from '../mongoose/services/bankThreeWayService.js';

/* ── helpers ──────────────────────────────────────────────────────── */

const D = (s) => new Date(`${s}T12:00:00Z`);

const sline = (over = {}) => ({
  _id: 'l1', uuid: 'l1', accountId: 611594, date: D('2026-08-03'),
  description: 'CARD PAYMENT TO SCREWFIX', amount: -16.46, status: 'unmatched', ...over,
});

const btx = (over = {}) => ({
  Id: 1, AccountId: 611594, Date: D('2026-08-03'),
  Comment: 'Purchase - SCRE01', PaidIn: 0, PaidOut: 16.46, ...over,
});

function fakeChain(result) {
  const q = {
    select() { return q; }, sort() { return q; }, limit() { return q; },
    lean() { return Promise.resolve(result); },
  };
  return q;
}

function patchMdb({ imports = [], lines = [], transactions = [] } = {}) {
  mdb.REST = { bankTransaction: { find: mock.fn(() => fakeChain(transactions)) } };
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    statementImport: { find: mock.fn(() => fakeChain(imports)) },
    statementLine: {
      find: mock.fn(() => fakeChain(lines)),
      bulkWrite: mock.fn(() => Promise.resolve({})),
      updateMany: mock.fn(() => Promise.resolve({})),
    },
  };
}

/* ── tests ────────────────────────────────────────────────────────── */

describe('bankThreeWayService', () => {
  beforeEach(() => patchMdb());

  describe('pairLines()', () => {
    it('pairs a statement line to the bank transaction for the same movement', () => {
      const r = pairLines([sline()], [btx()]);
      assert.equal(r.pairs.length, 1);
      assert.equal(r.pairs[0].dayGap, 0);
      assert.equal(r.unmatchedStatement.length, 0);
      assert.equal(r.unmatchedBank.length, 0);
    });

    it('allows a few days between the two records of one movement', () => {
      // A bank and a bookkeeper routinely date the same movement differently.
      const r = pairLines([sline()], [btx({ Date: D('2026-08-05') })]);
      assert.equal(r.pairs.length, 1);
      assert.equal(r.pairs[0].dayGap, 2);
    });

    it('will not pair beyond the window', () => {
      const r = pairLines([sline()], [btx({ Date: D('2026-08-20') })]);
      assert.equal(r.pairs.length, 0);
      assert.equal(r.unmatchedStatement.length, 1);
      assert.equal(r.unmatchedBank.length, 1);
    });

    it('will not pair across accounts', () => {
      const r = pairLines([sline()], [btx({ AccountId: 999 })]);
      assert.equal(r.pairs.length, 0);
    });

    it('requires the amount to agree to the penny, and to the sign', () => {
      assert.equal(pairLines([sline()], [btx({ PaidOut: 16.47 })]).pairs.length, 0);
      // Money out on the statement cannot pair with money in at the bank.
      assert.equal(pairLines([sline()], [btx({ PaidIn: 16.46, PaidOut: 0 })]).pairs.length, 0);
    });

    it('pairs money in as well as money out', () => {
      const r = pairLines(
        [sline({ amount: 250, description: 'BACS CREDIT' })],
        [btx({ PaidIn: 250, PaidOut: 0 })],
      );
      assert.equal(r.pairs.length, 1);
    });

    it('uses each side at most once', () => {
      const r = pairLines(
        [sline({ _id: 'a', uuid: 'a' }), sline({ _id: 'b', uuid: 'b' })],
        [btx({ Id: 1 })],
      );
      assert.equal(r.pairs.length, 1);
      assert.equal(r.unmatchedStatement.length, 1);
    });

    it('prefers the closest by date, deterministically', () => {
      const lines = [sline()];
      const txs = [btx({ Id: 1, Date: D('2026-08-05') }), btx({ Id: 2, Date: D('2026-08-03') })];
      assert.equal(pairLines(lines, txs).pairs[0].transaction.Id, 2);
      assert.equal(pairLines(lines, [...txs].reverse()).pairs[0].transaction.Id, 2);
    });

    it('reports a statement line with no bank transaction', () => {
      // The finding the whole feature exists for: money moved and KashFlow
      // has no record of it.
      const r = pairLines([sline({ description: 'UNKNOWN DEBIT', amount: -500 })], []);
      assert.equal(r.unmatchedStatement.length, 1);
      assert.equal(r.unmatchedStatement[0].description, 'UNKNOWN DEBIT');
    });

    it('reports a bank transaction absent from the statement', () => {
      const r = pairLines([], [btx()]);
      assert.equal(r.unmatchedBank.length, 1);
    });

    it('pairs in pence, so float error cannot break an exact match', () => {
      const r = pairLines([sline({ amount: -(0.1 + 0.2) })], [btx({ PaidOut: 0.3 })]);
      assert.equal(r.pairs.length, 1);
    });
  });

  describe('coveredPeriods()', () => {
    it('only trusts statements whose balance chain verified', async () => {
      // A parse that failed its chain may carry wrong amounts, and a wrong
      // amount here manufactures a discrepancy someone will chase for hours.
      patchMdb({ imports: [] });
      assert.deepEqual(await coveredPeriods(), []);

      // The query itself must demand it.
      const StatementImport = mdb.INTERNAL.statementImport;
      await coveredPeriods();
      const query = StatementImport.find.mock.calls[0].arguments[0];
      assert.equal(query.status, 'parsed');
      assert.equal(query.balanceChainOk, true);
    });

    it('merges overlapping and adjacent ranges', async () => {
      patchMdb({
        imports: [
          { accountId: 1, periodStart: D('2026-06-01'), periodEnd: D('2026-06-30') },
          { accountId: 1, periodStart: D('2026-07-01'), periodEnd: D('2026-07-31') },
          { accountId: 1, periodStart: D('2026-09-01'), periodEnd: D('2026-09-30') },
        ],
      });
      const [acct] = await coveredPeriods();
      // June and July join; September stands alone.
      assert.equal(acct.ranges.length, 2);
      assert.equal(acct.ranges[0].start.getTime(), D('2026-06-01').getTime());
      assert.equal(acct.ranges[0].end.getTime(), D('2026-07-31').getTime());
    });

    it('keeps accounts separate', async () => {
      patchMdb({
        imports: [
          { accountId: 1, periodStart: D('2026-06-01'), periodEnd: D('2026-06-30') },
          { accountId: 2, periodStart: D('2026-06-01'), periodEnd: D('2026-06-30') },
        ],
      });
      assert.equal((await coveredPeriods()).length, 2);
    });

    it('ignores an import with no period', async () => {
      patchMdb({ imports: [{ accountId: 1, periodStart: null, periodEnd: null }] });
      assert.deepEqual(await coveredPeriods(), []);
    });
  });

  describe('findDiscrepancies()', () => {
    it('reports nothing at all when no statement has been imported', async () => {
      // Without this, every bank transaction would read as "missing from the
      // statement" and the report would be pure noise.
      patchMdb({ imports: [], transactions: [btx()] });
      const r = await findDiscrepancies();
      assert.equal(r.hasStatements, false);
      assert.deepEqual(r.statementOnly, []);
      assert.deepEqual(r.bankOnly, []);
    });

    it('surfaces a statement line KashFlow never recorded', async () => {
      patchMdb({
        imports: [{ accountId: 611594, periodStart: D('2026-08-01'), periodEnd: D('2026-08-31') }],
        lines: [sline({ description: 'UNKNOWN DEBIT', amount: -500 })],
        transactions: [],
      });
      const r = await findDiscrepancies();
      assert.equal(r.hasStatements, true);
      assert.equal(r.statementOnly.length, 1);
      assert.equal(r.statementOnly[0].line.description, 'UNKNOWN DEBIT');
    });

    it('does not report a bank transaction outside the statemented period', async () => {
      // The fetch deliberately reaches past the range so edge dates can still
      // pair; those extras must not then be reported as missing.
      patchMdb({
        imports: [{ accountId: 611594, periodStart: D('2026-08-01'), periodEnd: D('2026-08-31') }],
        lines: [],
        transactions: [btx({ Id: 9, Date: D('2026-09-02') })],
      });
      const r = await findDiscrepancies();
      assert.equal(r.bankOnly.length, 0);
    });

    it('reports a bank transaction inside the period with no statement line', async () => {
      patchMdb({
        imports: [{ accountId: 611594, periodStart: D('2026-08-01'), periodEnd: D('2026-08-31') }],
        lines: [],
        transactions: [btx({ Id: 9, Date: D('2026-08-15') })],
      });
      const r = await findDiscrepancies();
      assert.equal(r.bankOnly.length, 1);
      assert.equal(r.bankOnly[0].transaction.amount, -16.46);
    });
  });
});
