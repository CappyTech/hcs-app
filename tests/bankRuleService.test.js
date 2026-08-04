import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import {
  ruleMatches,
  firstMatchingRule,
  buildMatchFromRule,
  applyRules,
  seedRules,
  SEED_RULES,
} from '../mongoose/services/bankRuleService.js';
import {
  findTransferPairs,
  buildMatchFromTransfer,
} from '../mongoose/services/bankTransferService.js';

/* ── helpers ──────────────────────────────────────────────────────── */

const line = (over = {}) => ({
  Id: 1, AccountId: 611594, Date: new Date('2025-06-10T12:00:00Z'),
  Type: 'Wages Control Net Pay', Comment: '', PaidIn: 0, PaidOut: 1500,
  ...over,
});

const rule = (conditions, over = {}) => ({
  _id: 'r1', name: 'Test rule', enabled: true, priority: 100,
  conditions, action: { matchType: 'no-document' }, ...over,
});

function fakeChain(result) {
  const q = {
    select() { return q; }, sort() { return q; }, limit() { return q; },
    lean() { return Promise.resolve(result); },
  };
  return q;
}

function patchMdb({ rules = [], lines = [], claimed = [], inserted = null } = {}) {
  const insertMany = mock.fn((docs) => Promise.resolve(inserted ?? docs));
  mdb.REST = { bankTransaction: { find: mock.fn(() => fakeChain(lines)) } };
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    bankRule: {
      find: mock.fn(() => fakeChain(rules)),
      insertMany,
      updateOne: mock.fn(() => Promise.resolve({})),
    },
    bankMatch: {
      distinct: mock.fn(() => Promise.resolve(claimed)),
      insertMany,
    },
  };
  return { insertMany };
}

/* ── tests ────────────────────────────────────────────────────────── */

describe('bankRuleService', () => {
  beforeEach(() => patchMdb());

  describe('ruleMatches()', () => {
    it('matches on Type exactly, case-insensitively', () => {
      assert.ok(ruleMatches(rule({ typeEquals: 'wages control net pay' }), line()));
      assert.ok(!ruleMatches(rule({ typeEquals: 'Bank charges' }), line()));
    });

    it('matches on a Type substring', () => {
      assert.ok(ruleMatches(rule({ typeContains: 'wages' }), line()));
      assert.ok(!ruleMatches(rule({ typeContains: 'pension' }), line()));
    });

    it('matches on a Comment substring', () => {
      assert.ok(ruleMatches(rule({ commentContains: 'bbls' }), line({ Comment: 'BBLS repayment' })));
      assert.ok(!ruleMatches(rule({ commentContains: 'bbls' }), line({ Comment: '' })));
    });

    it('ANDs every populated condition', () => {
      const r = rule({ typeContains: 'wages', accountId: 611594, direction: 'out' });
      assert.ok(ruleMatches(r, line()));
      // One condition failing is enough to reject.
      assert.ok(!ruleMatches(r, line({ AccountId: 999 })));
      assert.ok(!ruleMatches(r, line({ PaidIn: 100, PaidOut: 0 })));
    });

    it('matches an empty rule against nothing, not everything', () => {
      // A rule that swallowed every line would be miserable to diagnose.
      assert.ok(!ruleMatches(rule({}), line()));
      assert.ok(!ruleMatches(rule({ direction: 'any' }), line()));
    });

    it('matches amounts in pence, so an exact boundary is not lost to float error', () => {
      assert.ok(ruleMatches(rule({ amountEquals: 1500 }), line({ PaidOut: 1500 })));
      assert.ok(ruleMatches(rule({ amountMin: 100, amountMax: 1500 }), line({ PaidOut: 1500 })));
      assert.ok(ruleMatches(rule({ amountMin: 887.37, amountMax: 887.37 }), line({ PaidOut: 887.37 })));
      assert.ok(!ruleMatches(rule({ amountMax: 1499.99 }), line({ PaidOut: 1500 })));
    });

    it('compares the magnitude, not the sign, for amount conditions', () => {
      assert.ok(ruleMatches(rule({ amountEquals: 887.37 }), line({ PaidIn: 887.37, PaidOut: 0 })));
    });

    it('treats accountId null as any account', () => {
      assert.ok(ruleMatches(rule({ typeContains: 'wages', accountId: null }), line({ AccountId: 12345 })));
    });
  });

  describe('firstMatchingRule()', () => {
    const wages = rule({ typeContains: 'wages' }, { _id: 'a', name: 'general', priority: 100 });
    const specific = rule({ typeEquals: 'Wages Control Net Pay', accountId: 611594 }, { _id: 'b', name: 'specific', priority: 10 });

    it('returns the lowest priority first', () => {
      assert.equal(firstMatchingRule([wages, specific], line()).name, 'specific');
      assert.equal(firstMatchingRule([specific, wages], line()).name, 'specific');
    });

    it('breaks ties by age, so the result does not depend on input order', () => {
      const older = rule({ typeContains: 'wages' }, { _id: 'x', name: 'older', priority: 50, createdAt: '2025-01-01' });
      const newer = rule({ typeContains: 'wages' }, { _id: 'y', name: 'newer', priority: 50, createdAt: '2025-06-01' });
      assert.equal(firstMatchingRule([newer, older], line()).name, 'older');
      assert.equal(firstMatchingRule([older, newer], line()).name, 'older');
    });

    it('skips disabled rules', () => {
      assert.equal(firstMatchingRule([{ ...specific, enabled: false }, wages], line()).name, 'general');
    });

    it('returns null when nothing applies', () => {
      assert.equal(firstMatchingRule([specific], line({ Type: 'Bank charges' })), null);
      assert.equal(firstMatchingRule([], line()), null);
    });
  });

  describe('buildMatchFromRule()', () => {
    it('produces a suggestion with no documents', () => {
      // These lines are postings to a nominal account, not the settlement of
      // an invoice — there is nothing to allocate against.
      const m = buildMatchFromRule(rule({ typeContains: 'wages' }, { name: 'Wages' }), line());
      assert.equal(m.status, 'suggested');
      assert.equal(m.origin, 'rule');
      assert.equal(m.matchType, 'no-document');
      assert.deepEqual(m.documents, []);
      assert.equal(m.bankLines.length, 1);
      assert.equal(m.totals.bankTotal, -1500);
      assert.match(m.reasons[0], /Wages/);
    });

    it('confirms only when the rule opts in', () => {
      const r = rule({ typeContains: 'wages' }, { name: 'Auto', autoConfirm: true });
      const m = buildMatchFromRule(r, line());
      assert.equal(m.status, 'confirmed');
      assert.match(m.reviewedByName, /Rule: Auto/);

      const suggestOnly = buildMatchFromRule(rule({ typeContains: 'wages' }), line());
      assert.equal(suggestOnly.status, 'suggested');
    });

    it('records the direction from the amount', () => {
      assert.equal(buildMatchFromRule(rule({ typeContains: 'wages' }), line()).direction, 'out');
      assert.equal(buildMatchFromRule(rule({ typeContains: 'wages' }), line({ PaidIn: 5, PaidOut: 0 })).direction, 'in');
    });
  });

  describe('applyRules()', () => {
    it('creates one match per matching line and reports per rule', async () => {
      patchMdb({
        rules: [rule({ typeContains: 'wages' }, { name: 'Wages' })],
        lines: [line({ Id: 1 }), line({ Id: 2 }), line({ Id: 3, Type: 'Bank charges' })],
      });
      const stats = await applyRules();

      assert.equal(stats.examined, 3);
      assert.equal(stats.created, 2);
      assert.equal(stats.unmatched, 1);
      assert.equal(stats.byRule.Wages, 2);
    });

    it('excludes already-matched lines in the QUERY, not after fetching', async () => {
      // Filtering after the fetch makes `limit` apply to already-processed
      // rows, so each run re-reads the same newest `limit` lines and the older
      // backlog is never reached. That shipped: 13,429 lines, a 5,000 limit,
      // and exactly 5,000 suggestions that would never have grown.
      patchMdb({
        rules: [rule({ typeContains: 'wages' }, { name: 'Wages' })],
        lines: [line({ Id: 2 })],
        claimed: [1, 5, 9],
      });
      await applyRules();

      const query = mdb.REST.bankTransaction.find.mock.calls[0].arguments[0];
      assert.deepEqual(query.Id, { $nin: [1, 5, 9] }, 'claimed ids must be excluded by the query');
      assert.equal(query.EntityName, 'banktransaction');
    });

    it('omits the exclusion entirely when nothing is claimed', async () => {
      patchMdb({
        rules: [rule({ typeContains: 'wages' }, { name: 'Wages' })],
        lines: [line({ Id: 1 })],
        claimed: [],
      });
      await applyRules();
      const query = mdb.REST.bankTransaction.find.mock.calls[0].arguments[0];
      assert.equal(query.Id, undefined, 'an empty $nin would be pointless');
    });

    it('does nothing when no rules exist', async () => {
      patchMdb({ rules: [], lines: [line()] });
      const stats = await applyRules();
      assert.equal(stats.created, 0);
      assert.equal(stats.examined, 0);
    });
  });

  describe('seedRules()', () => {
    it('covers the recurring categories in this dataset', () => {
      const names = SEED_RULES.map(r => r.name).join(' ').toLowerCase();
      for (const expected of ['wages', 'cis', 'vat', 'directors loan', 'bank charges', 'pension']) {
        assert.ok(names.includes(expected), `no seed rule for ${expected}`);
      }
    });

    it('ships every seed rule as suggest-only', async () => {
      // autoConfirm is the one place the "a person confirms" guarantee is
      // relaxed; nothing should arrive with it already on.
      const { insertMany } = patchMdb({ rules: [] });
      await seedRules();
      const created = insertMany.mock.calls[0].arguments[0];
      assert.ok(created.length > 0);
      for (const r of created) {
        assert.equal(r.autoConfirm, false, `${r.name} ships with autoConfirm on`);
        assert.equal(r.seeded, true);
      }
    });

    it('does not duplicate rules that already exist', async () => {
      const existing = SEED_RULES.map(r => ({ name: r.name }));
      patchMdb({ rules: existing });
      mdb.INTERNAL.bankRule.find = mock.fn(() => fakeChain(existing));
      const res = await seedRules();
      assert.equal(res.created, 0);
    });
  });
});

describe('bankTransferService', () => {
  const tx = (over) => ({ Id: 1, AccountId: 1, Date: new Date('2025-06-10T12:00:00Z'), PaidIn: 0, PaidOut: 0, Type: '', Comment: '', ...over });

  describe('findTransferPairs()', () => {
    it('pairs equal and opposite amounts across two accounts', () => {
      const pairs = findTransferPairs([
        tx({ Id: 1, AccountId: 578587, PaidOut: 2933 }),
        tx({ Id: 2, AccountId: 611594, PaidIn: 2933 }),
      ]);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].out.Id, 1);
      assert.equal(pairs[0].in.Id, 2);
    });

    it('will not pair two lines on the same account', () => {
      const pairs = findTransferPairs([
        tx({ Id: 1, AccountId: 611594, PaidOut: 100 }),
        tx({ Id: 2, AccountId: 611594, PaidIn: 100 }),
      ]);
      assert.equal(pairs.length, 0);
    });

    it('allows a day between the two halves but not a week', () => {
      const near = findTransferPairs([
        tx({ Id: 1, AccountId: 1, PaidOut: 100, Date: new Date('2025-06-10T12:00:00Z') }),
        tx({ Id: 2, AccountId: 2, PaidIn: 100, Date: new Date('2025-06-11T12:00:00Z') }),
      ]);
      assert.equal(near.length, 1);

      const far = findTransferPairs([
        tx({ Id: 1, AccountId: 1, PaidOut: 100, Date: new Date('2025-06-10T12:00:00Z') }),
        tx({ Id: 2, AccountId: 2, PaidIn: 100, Date: new Date('2025-06-17T12:00:00Z') }),
      ]);
      assert.equal(far.length, 0);
    });

    it('uses each line at most once', () => {
      const pairs = findTransferPairs([
        tx({ Id: 1, AccountId: 1, PaidOut: 100 }),
        tx({ Id: 2, AccountId: 2, PaidIn: 100 }),
        tx({ Id: 3, AccountId: 3, PaidIn: 100 }),
      ]);
      assert.equal(pairs.length, 1);
    });

    it('is deterministic regardless of input order', () => {
      const lines = [
        tx({ Id: 1, AccountId: 1, PaidOut: 100, Date: new Date('2025-06-10T12:00:00Z') }),
        tx({ Id: 2, AccountId: 2, PaidIn: 100, Date: new Date('2025-06-11T12:00:00Z') }),
        tx({ Id: 3, AccountId: 3, PaidIn: 100, Date: new Date('2025-06-10T12:00:00Z') }),
      ];
      const a = findTransferPairs(lines);
      const b = findTransferPairs([...lines].reverse());
      assert.equal(a[0].in.Id, b[0].in.Id, 'closest by date must win either way');
      assert.equal(a[0].in.Id, 3);
    });

    it('pairs in pence, so an exact amount is never missed', () => {
      const pairs = findTransferPairs([
        tx({ Id: 1, AccountId: 1, PaidOut: 0.1 + 0.2 }),
        tx({ Id: 2, AccountId: 2, PaidIn: 0.3 }),
      ]);
      assert.equal(pairs.length, 1);
    });
  });

  describe('buildMatchFromTransfer()', () => {
    it('records both halves and nets to zero', () => {
      const m = buildMatchFromTransfer({
        out: tx({ Id: 1, AccountId: 578587, PaidOut: 2933 }),
        in: tx({ Id: 2, AccountId: 611594, PaidIn: 2933 }),
      });
      assert.equal(m.matchType, 'transfer');
      assert.equal(m.bankLines.length, 2);
      assert.deepEqual(m.documents, []);
      // The halves cancel — which is what makes a transfer self-evidencing.
      assert.equal(m.bankLines.reduce((s, l) => s + l.amount, 0), 0);
      assert.equal(m.totals.bankTotal, 0);
      assert.equal(m.status, 'suggested');
      assert.match(m.reasons[0], /578587 to 611594/);
    });
  });
});
