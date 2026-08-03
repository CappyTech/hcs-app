import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import {
  validateAllocations,
  confirmMatch,
  rejectMatch,
  unconfirmMatch,
  bulkConfirm,
  createSignOff,
  reopenSignOff,
} from '../mongoose/services/bankReconciliationService.js';

/* ── fakes ────────────────────────────────────────────────────────── */

/** A stand-in Mongoose document: tracks saves, supports Object.assign. */
function fakeDoc(props) {
  const doc = {
    _id: props._id || 'oid-1',
    saveCount: 0,
    deletedAt: null,
    save() { this.saveCount += 1; return Promise.resolve(this); },
    ...props,
  };
  return doc;
}

function fakeChain(result) {
  const q = { select() { return q; }, lean() { return Promise.resolve(result); } };
  return q;
}

const user = { _id: 'user-1', name: 'A Accountant', email: 'acct@example.com' };

const suggested = (over = {}) => fakeDoc({
  uuid: 'm-1',
  accountId: 611594,
  status: 'suggested',
  direction: 'out',
  matchType: 'document',
  bankLines: [{ bankTransactionId: 99, amount: -16.46, date: new Date('2025-01-15') }],
  documents: [{ kind: 'purchase', kfId: 900, docKey: 'purchase:900', allocatedAmount: 16.46 }],
  signOffId: null,
  reviewNote: '',
  ...over,
});

/** Patch mdb.INTERNAL with controllable bankMatch / bankSignOff fakes. */
function patchMdb({ match = null, conflicts = [], confirmedInPeriod = [], suggestedInPeriod = [],
  outstanding = 0, signOff = null, existingSignOff = null } = {}) {
  const saved = [];

  class FakeBankMatch {
    constructor(props) { Object.assign(this, props); this.uuid = props.uuid || 'm-new'; this._id = 'oid-new'; }
    save() { saved.push(this); return Promise.resolve(this); }
  }
  FakeBankMatch.findOne = mock.fn(() => Promise.resolve(match));
  FakeBankMatch.find = mock.fn((q) => {
    if (q?.status === 'confirmed' && q['bankLines.date']) return fakeChain(confirmedInPeriod);
    if (q?.status === 'suggested') return fakeChain(suggestedInPeriod);
    return fakeChain(conflicts);
  });
  FakeBankMatch.countDocuments = mock.fn(() => Promise.resolve(outstanding));
  FakeBankMatch.updateMany = mock.fn(() => Promise.resolve({ modifiedCount: 1 }));

  class FakeSignOff {
    constructor(props) { Object.assign(this, props); this.uuid = 's-new'; this._id = 'so-1'; }
    save() { saved.push(this); return Promise.resolve(this); }
  }
  FakeSignOff.findOne = mock.fn((q) => (
    q?.status === 'signed' ? fakeChain(existingSignOff) : Promise.resolve(signOff)
  ));

  mdb.INTERNAL = { ...mdb.INTERNAL, bankMatch: FakeBankMatch, bankSignOff: FakeSignOff };
  return { saved, FakeBankMatch, FakeSignOff };
}

/* ── tests ────────────────────────────────────────────────────────── */
describe('bankReconciliationService', () => {
  beforeEach(() => patchMdb());

  describe('validateAllocations()', () => {
    it('accepts allocations that account for the bank movement', () => {
      const r = validateAllocations({
        bankLines: [{ amount: -16.46 }],
        documents: [{ kind: 'purchase', allocatedAmount: 16.46 }],
      });
      assert.equal(r.ok, true);
    });

    it('rejects an under-allocation', () => {
      const r = validateAllocations({
        bankLines: [{ amount: -100 }],
        documents: [{ kind: 'purchase', allocatedAmount: 60 }],
      });
      assert.equal(r.ok, false);
      assert.equal(r.expected, 100);
      assert.equal(r.allocated, 60);
    });

    it('rejects an over-allocation', () => {
      const r = validateAllocations({
        bankLines: [{ amount: -100 }],
        documents: [{ kind: 'purchase', allocatedAmount: 140 }],
      });
      assert.equal(r.ok, false);
    });

    it('sums several bank lines against several documents', () => {
      const r = validateAllocations({
        bankLines: [{ amount: -60 }, { amount: -40 }],
        documents: [
          { kind: 'purchase', allocatedAmount: 30 },
          { kind: 'purchase', allocatedAmount: 70 },
        ],
      });
      assert.equal(r.ok, true);
    });

    it('accepts a refund, where both signs are inverted', () => {
      const r = validateAllocations({
        bankLines: [{ amount: 576 }],
        documents: [{ kind: 'purchase', allocatedAmount: -576 }],
      });
      assert.equal(r.ok, true);
    });

    it('passes matches with no documents at all', () => {
      // Transfers, bank charges, journals.
      const r = validateAllocations({ bankLines: [{ amount: -25 }], documents: [] });
      assert.equal(r.ok, true);
    });

    it('tolerates a penny of rounding', () => {
      const r = validateAllocations({
        bankLines: [{ amount: -100 }],
        documents: [{ kind: 'purchase', allocatedAmount: 100.01 }],
      });
      assert.equal(r.ok, true);
    });
  });

  describe('confirmMatch()', () => {
    it('confirms a valid match and records the reviewer', async () => {
      const m = suggested();
      patchMdb({ match: m });
      const out = await confirmMatch('m-1', { user, reviewNote: 'checked against statement' });

      assert.equal(out.status, 'confirmed');
      assert.equal(out.reviewedByName, 'A Accountant');
      assert.equal(out.reviewedByEmail, 'acct@example.com');
      assert.ok(out.reviewedAt instanceof Date);
      assert.equal(out.reviewNote, 'checked against statement');
      assert.equal(m.saveCount, 1);
    });

    it('refuses when allocations do not account for the bank amount', async () => {
      const m = suggested({ documents: [{ kind: 'purchase', kfId: 900, docKey: 'purchase:900', allocatedAmount: 5 }] });
      patchMdb({ match: m });

      await assert.rejects(
        () => confirmMatch('m-1', { user }),
        /Allocations total 5\.00 but the bank line implies 16\.46/,
      );
      assert.equal(m.saveCount, 0, 'must not save a match it refused');
    });

    it('applies reviewer-adjusted documents before validating', async () => {
      const m = suggested({ documents: [{ kind: 'purchase', kfId: 900, docKey: 'purchase:900', allocatedAmount: 5 }] });
      patchMdb({ match: m });

      const out = await confirmMatch('m-1', {
        user,
        documents: [{ kind: 'purchase', kfId: 900, docKey: 'purchase:900', allocatedAmount: 16.46 }],
      });
      assert.equal(out.status, 'confirmed');
    });

    it('refuses to double-claim a bank line already confirmed elsewhere', async () => {
      const m = suggested();
      patchMdb({
        match: m,
        conflicts: [{ uuid: 'other', bankLines: [{ bankTransactionId: 99 }], documents: [] }],
      });

      await assert.rejects(() => confirmMatch('m-1', { user }), /Already accounted for by confirmed match other/);
      assert.equal(m.saveCount, 0);
    });

    it('refuses a match that is already confirmed', async () => {
      patchMdb({ match: suggested({ status: 'confirmed' }) });
      await assert.rejects(() => confirmMatch('m-1', { user }), /already confirmed/);
    });

    it('refuses a superseded match', async () => {
      patchMdb({ match: suggested({ status: 'superseded' }) });
      await assert.rejects(() => confirmMatch('m-1', { user }), /has been superseded/);
    });

    it('404s an unknown match', async () => {
      patchMdb({ match: null });
      await assert.rejects(() => confirmMatch('nope', { user }), /Match not found/);
    });
  });

  describe('rejectMatch()', () => {
    it('requires a reason', async () => {
      patchMdb({ match: suggested() });
      await assert.rejects(() => rejectMatch('m-1', { user, reason: '   ' }), /reason is required/);
    });

    it('records the reason and reviewer', async () => {
      const m = suggested();
      patchMdb({ match: m });
      const out = await rejectMatch('m-1', { user, reason: 'wrong supplier' });

      assert.equal(out.status, 'rejected');
      assert.equal(out.rejectedReason, 'wrong supplier');
      assert.equal(out.reviewedByName, 'A Accountant');
    });

    it('will not reject a confirmed match', async () => {
      patchMdb({ match: suggested({ status: 'confirmed' }) });
      await assert.rejects(() => rejectMatch('m-1', { user, reason: 'x' }), /must be unconfirmed rather than rejected/);
    });
  });

  describe('unconfirmMatch()', () => {
    it('supersedes rather than deleting, and creates a fresh suggestion', async () => {
      const m = suggested({ status: 'confirmed' });
      patchMdb({ match: m });

      const { original, replacement } = await unconfirmMatch('m-1', { user, reason: 'wrong invoice' });

      assert.equal(original.status, 'superseded');
      assert.ok(original.supersededAt instanceof Date);
      assert.equal(original.supersededBy, replacement._id);
      assert.equal(replacement.status, 'suggested');
      assert.equal(replacement.supersedes, original._id);
      assert.match(original.reviewNote, /wrong invoice/);
    });

    it('refuses a match belonging to a signed-off period', async () => {
      patchMdb({ match: suggested({ status: 'confirmed', signOffId: 'so-1' }) });
      await assert.rejects(() => unconfirmMatch('m-1', { user }), /Reopen the period first/);
    });

    it('refuses anything that is not confirmed', async () => {
      patchMdb({ match: suggested({ status: 'suggested' }) });
      await assert.rejects(() => unconfirmMatch('m-1', { user }), /Only confirmed matches/);
    });
  });

  describe('bulkConfirm()', () => {
    it('carries on past a failure and reports both outcomes', async () => {
      // The whole point of bulk confirm is clearing a backlog; one bad row
      // must not abandon the rest of the batch.
      let call = 0;
      const good = suggested();
      const bad = suggested({ uuid: 'm-2', documents: [{ kind: 'purchase', kfId: 1, docKey: 'purchase:1', allocatedAmount: 999 }] });
      const { FakeBankMatch } = patchMdb({ match: good });
      FakeBankMatch.findOne = mock.fn(() => Promise.resolve([good, bad][call++] || null));

      const res = await bulkConfirm(['m-1', 'm-2'], { user });
      assert.deepEqual(res.confirmed, ['m-1']);
      assert.equal(res.failed.length, 1);
      assert.equal(res.failed[0].uuid, 'm-2');
    });
  });

  describe('createSignOff()', () => {
    const period = {
      accountId: 611594,
      accountName: 'Heron Constructive Solutions LTD',
      periodStart: '2025-01-01',
      periodEnd: '2025-01-31',
      openingBalance: 1000,
      user,
    };

    it('refuses while matches are still awaiting review', async () => {
      patchMdb({ outstanding: 3 });
      await assert.rejects(() => createSignOff(period), /3 matches in this period are still awaiting review/);
    });

    it('signs off when nothing is outstanding', async () => {
      patchMdb({ outstanding: 0, confirmedInPeriod: [{ _id: 'a', bankLines: [{ amount: -200 }] }] });
      const s = await createSignOff(period);

      assert.equal(s.status, 'signed');
      assert.equal(s.signedByName, 'A Accountant');
      assert.equal(s.matchedCount, 1);
      assert.equal(s.closingBalancePerLedger, 800); // 1000 - 200
    });

    it('records the gap when forced over an unreviewed backlog', async () => {
      patchMdb({
        outstanding: 2,
        confirmedInPeriod: [{ _id: 'a', bankLines: [{ amount: -200 }] }],
        suggestedInPeriod: [{ bankLines: [{ amount: -50 }] }, { bankLines: [{ amount: -25 }] }],
      });
      const s = await createSignOff({ ...period, force: true });

      assert.equal(s.status, 'signed');
      assert.equal(s.unmatchedCount, 2);
      assert.equal(s.unmatchedValue, -75);
    });

    it('computes variance against the statement balance', async () => {
      patchMdb({ outstanding: 0, confirmedInPeriod: [{ _id: 'a', bankLines: [{ amount: -200 }] }] });
      const s = await createSignOff({ ...period, closingBalancePerStatement: 790 });

      assert.equal(s.closingBalancePerLedger, 800);
      assert.equal(s.variance, -10);
    });

    it('refuses a period already signed off', async () => {
      patchMdb({ outstanding: 0, existingSignOff: { uuid: 'existing' } });
      await assert.rejects(() => createSignOff(period), /already been signed off/);
    });

    it('rejects an inverted period', async () => {
      patchMdb({ outstanding: 0 });
      await assert.rejects(
        () => createSignOff({ ...period, periodStart: '2025-01-31', periodEnd: '2025-01-01' }),
        /on or after the period start/,
      );
    });
  });

  describe('reopenSignOff()', () => {
    it('requires a reason', async () => {
      patchMdb({ signOff: fakeDoc({ uuid: 's-1', status: 'signed' }) });
      await assert.rejects(() => reopenSignOff('s-1', { user, reason: '' }), /reason is required/);
    });

    it('reopens and releases the matches', async () => {
      const so = fakeDoc({ uuid: 's-1', status: 'signed' });
      const { FakeBankMatch } = patchMdb({ signOff: so });

      const out = await reopenSignOff('s-1', { user, reason: 'invoice restated' });

      assert.equal(out.status, 'reopened');
      assert.equal(out.reopenReason, 'invoice restated');
      assert.equal(out.reopenedByName, 'A Accountant');
      assert.equal(FakeBankMatch.updateMany.mock.callCount(), 1);
    });

    it('refuses a period that is not signed', async () => {
      patchMdb({ signOff: fakeDoc({ uuid: 's-1', status: 'reopened' }) });
      await assert.rejects(() => reopenSignOff('s-1', { user, reason: 'x' }), /Only a signed period/);
    });
  });
});
