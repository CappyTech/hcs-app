import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import OcrDocumentDef from '../mongoose/models/mongoose/PAPERLESS/OcrDocument.js';
import state from '../mongoose/services/paperless/documentStateService.js';

const { TRANSITIONS, planTransition, buildTransitionUpdate, transition, actorFromUser, markStatementReviewed, setExcludedReason } = state;

/** H2: processing state transitions (PAPERLESS-MIGRATION.md H2, PB-3/5/7/8/9/10/12). */

const PI = { id: 1, name: 'Purchase Invoice' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const BANK = { id: 4, name: 'Bank Statement' };

const user = { userId: new mongoose.Types.ObjectId(), name: 'bev', isAdmin: false };
const admin = { userId: new mongoose.Types.ObjectId(), name: 'jack', isAdmin: true };

// In-memory OcrDocument supporting the calls the service makes: equality and
// $ne filters, $set and $push/$each updates.
function fakeOcrDocument(docs) {
  const rows = docs.map((d) => structuredClone(d));
  const matches = (r, filter) => Object.entries(filter).every(([k, v]) => {
    const actual = r[k] ?? null;
    if (v && typeof v === 'object' && '$ne' in v) return actual !== v.$ne;
    return actual === v;
  });
  const clone = (r) => (r ? structuredClone(r) : null);
  return {
    rows,
    findOne(filter) {
      const hit = () => clone(rows.find((r) => matches(r, filter)));
      return { select: () => ({ lean: async () => hit() }), lean: async () => hit() };
    },
    findOneAndUpdate(filter, update) {
      return {
        lean: async () => {
          const r = rows.find((x) => matches(x, filter));
          if (!r) return null;
          Object.assign(r, update.$set || {});
          for (const [k, v] of Object.entries(update.$push || {})) {
            r[k] = [...(r[k] || []), ...(v.$each || [v])];
          }
          return clone(r);
        },
      };
    },
  };
}

describe('OcrDocument processing fields', () => {
  const Model = new mongoose.Mongoose().model('OcrDocument', OcrDocumentDef.schema);

  it('defaults to no state, so existing documents are not suddenly awaiting entry', () => {
    const d = new Model({ paperlessId: 1 });
    assert.equal(d.processingState, null);
    assert.equal(d.statementReviewed, false);
    assert.equal(d.creditNote, false);
    assert.equal(d.excludedReason, null);
  });

  it('rejects unknown states and exclusion reasons', async () => {
    await assert.rejects(new Model({ paperlessId: 1, processingState: 'done' }).validate());
    await assert.rejects(new Model({ paperlessId: 1, excludedReason: 'whatever' }).validate());
  });

  it('accepts every state the service can produce', async () => {
    for (const to of new Set(Object.values(TRANSITIONS).map((t) => t.to))) {
      await new Model({ paperlessId: 1, processingState: to }).validate();
    }
  });
});

describe('planTransition', () => {
  const doc = (processingState, documentType = PI) => ({ paperlessId: 1, documentType, processingState });

  const allowed = [
    ['initialise', null, 'awaiting_entry'],
    ['complete_entry', 'awaiting_entry', 'entered'],
    ['mark_sent', 'entered', 'sent'],
    ['unlink', 'sent', 'entered'],
    ['flag_credit_note', 'awaiting_entry', 'manual_kashflow'],
    ['flag_credit_note', 'entered', 'manual_kashflow'],
  ];
  for (const [action, from, to] of allowed) {
    it(`${action}: ${from ?? '(none)'} → ${to}`, () => {
      const plan = planTransition(doc(from), action, user);
      assert.equal(plan.ok, true, plan.message);
      assert.equal(plan.to, to);
    });
  }

  it('admin-only: reopen entry and unflag a credit note', () => {
    assert.equal(planTransition(doc('entered'), 'reopen_entry', user).reason, 'forbidden');
    assert.equal(planTransition(doc('entered'), 'reopen_entry', admin).to, 'awaiting_entry');
    assert.equal(planTransition(doc('manual_kashflow'), 'unflag_credit_note', user).reason, 'forbidden');
    const unflag = planTransition(doc('manual_kashflow'), 'unflag_credit_note', admin);
    assert.equal(unflag.to, 'awaiting_entry');
    assert.deepEqual(unflag.sets, { creditNote: false });
  });

  const refused = [
    ['complete_entry', 'entered'],         // saving again does not re-complete (PB-5)
    ['complete_entry', null],
    ['mark_sent', 'awaiting_entry'],       // must be entered first
    ['mark_sent', 'manual_kashflow'],      // credit notes are never sent (PB-12)
    ['mark_sent', 'sent'],
    ['flag_credit_note', 'sent'],          // already in KashFlow: unlink first
    ['flag_credit_note', 'manual_kashflow'],
    ['unlink', 'entered'],
    ['initialise', 'awaiting_entry'],
  ];
  for (const [action, from] of refused) {
    it(`refuses ${action} from ${from ?? '(none)'}`, () => {
      assert.equal(planTransition(doc(from), action, admin).reason, 'invalid-state');
    });
  }

  it('applies to subcontractor invoices too', () => {
    assert.equal(planTransition(doc(null, SI), 'initialise', user).ok, true);
  });

  it('gives statements, bank statements and untyped documents no state', () => {
    for (const t of [STATEMENT, BANK, null]) {
      assert.equal(planTransition(doc(null, t), 'initialise', admin).reason, 'not-invoice');
    }
  });

  it('reports unknown actions and missing documents', () => {
    assert.equal(planTransition(doc(null), 'teleport', admin).reason, 'unknown-action');
    assert.equal(planTransition(null, 'initialise', admin).reason, 'not-found');
  });
});

describe('buildTransitionUpdate', () => {
  it('is a compare-and-set on the current state, stamped and logged', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const plan = planTransition({ documentType: PI, processingState: 'entered' }, 'flag_credit_note', user);
    const { filter, update } = buildTransitionUpdate(9002, plan, user, { now, note: 'ticked on entry screen' });

    assert.deepEqual(filter, { paperlessId: 9002, processingState: 'entered' });
    assert.equal(update.$set.processingState, 'manual_kashflow');
    assert.equal(update.$set.creditNote, true);
    const by = { userId: user.userId, name: 'bev' };
    assert.deepEqual(update.$set.processingStateChanged, { at: now, by });
    assert.deepEqual(update.$set.creditNoteChanged, { at: now, by });
    assert.deepEqual(update.$push.processingHistory.$each.map((h) => [h.field, h.from, h.to]), [
      ['processingState', 'entered', 'manual_kashflow'],
      ['creditNote', false, true],
    ]);
    assert.ok(update.$push.processingHistory.$each.every((h) => !('isAdmin' in h.by)));
  });
});

describe('transition', () => {
  let OcrDocument;
  beforeEach(() => {
    OcrDocument = fakeOcrDocument([
      { paperlessId: 9001, documentType: PI, processingState: null },
      { paperlessId: 9005, documentType: STATEMENT, processingState: null, statementReviewed: false },
    ]);
  });

  it('walks an invoice through the whole process', async () => {
    for (const action of ['initialise', 'complete_entry', 'mark_sent', 'unlink', 'mark_sent']) {
      const r = await transition(OcrDocument, 9001, action, user);
      assert.equal(r.ok, true, `${action}: ${r.message}`);
    }
    const row = OcrDocument.rows[0];
    assert.equal(row.processingState, 'sent');
    assert.equal(row.processingHistory.length, 5);
    assert.equal(row.processingStateChanged.by.name, 'bev');
  });

  it('lets only one of two concurrent actions apply', async () => {
    await transition(OcrDocument, 9001, 'initialise', user);
    const [a, b] = await Promise.all([
      transition(OcrDocument, 9001, 'complete_entry', user),
      transition(OcrDocument, 9001, 'complete_entry', user),
    ]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    assert.equal([a, b].find((r) => !r.ok).reason, 'conflict');
    assert.equal(OcrDocument.rows[0].processingHistory.length, 2);
  });

  it('returns not-found for an unknown document', async () => {
    assert.equal((await transition(OcrDocument, 1, 'initialise', user)).reason, 'not-found');
  });
});

describe('markStatementReviewed', () => {
  it('only the first review counts (C2a is sent once)', async () => {
    const OcrDocument = fakeOcrDocument([{ paperlessId: 9005, documentType: STATEMENT, statementReviewed: false }]);
    assert.deepEqual(await markStatementReviewed(OcrDocument, 9005, user), { ok: true, firstTime: true });
    assert.deepEqual(await markStatementReviewed(OcrDocument, 9005, user), { ok: true, firstTime: false });
    assert.equal(OcrDocument.rows[0].processingHistory.length, 1);
  });

  it('refuses anything that is not a supplier statement', async () => {
    const OcrDocument = fakeOcrDocument([{ paperlessId: 9001, documentType: PI }]);
    assert.equal((await markStatementReviewed(OcrDocument, 9001, user)).reason, 'not-statement');
  });
});

describe('setExcludedReason', () => {
  it('sets, ignores a no-op, clears, and logs each change', async () => {
    const OcrDocument = fakeOcrDocument([{ paperlessId: 9001, documentType: PI, excludedReason: null }]);
    assert.deepEqual(await setExcludedReason(OcrDocument, 9001, 'manually_added', user), { ok: true, changed: true });
    assert.deepEqual(await setExcludedReason(OcrDocument, 9001, 'manually_added', user), { ok: true, changed: false });
    assert.deepEqual(await setExcludedReason(OcrDocument, 9001, null, user), { ok: true, changed: true });
    assert.equal(OcrDocument.rows[0].processingHistory.length, 2);
    assert.equal((await setExcludedReason(OcrDocument, 9001, 'lost', user)).reason, 'invalid-reason');
  });
});

describe('actorFromUser', () => {
  it('maps req.user, keeping admin as a flag only', () => {
    const _id = new mongoose.Types.ObjectId();
    assert.deepEqual(actorFromUser({ _id, username: 'jack', role: 'admin' }), { userId: _id, name: 'jack', isAdmin: true });
    assert.equal(actorFromUser({ _id: 'not-an-objectid', username: 'x', role: 'user' }).userId, null);
    assert.deepEqual(actorFromUser(null), { userId: null, name: 'system', isAdmin: false });
  });
});
