import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mongoose from 'mongoose';
import sift from 'sift';

import NotificationLogDef from '../mongoose/models/mongoose/PAPERLESS/NotificationLog.js';
import backfill from '../mongoose/services/paperless/backfillService.js';
import queues from '../mongoose/services/paperless/documentQueueService.js';
import { hasTag } from '../mongoose/config/paperlessTagsConfig.js';
import { isDocumentType } from '../mongoose/config/paperlessTypesConfig.js';

const { sentNotifications, planDocument, runBackfill, formatSummary, BACKFILL_NOTE } = backfill;

/** H7: backfill (PAPERLESS-MIGRATION.md H7). Running it twice changes nothing the second time. */

const PI = { id: 1, name: 'Purchase Invoice' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const BANK = { id: 4, name: 'Bank Statement' };
const t = (id, name) => ({ id, name });
const T = {
  dataEntryDone: t(1, 'data entry done'), added: t(2, 'added'), inbox: t(3, 'inbox'), originalMulti: t(4, 'original/multiple invoice one pdf'),
  manual: t(11, 'manually added to kashflow'), john: t(19, 'notified/john'), kf: t(20, 'notified/kashflow'),
  statementSent: t(21, 'notified/admin-statement'), creditSent: t(22, 'notified/credit-note'),
};

// ── Fakes (sift for the real Mongo filters) ─────────────────────────

function siftOcrDocument(docs) {
  const rows = docs.map((d) => ({
    processingState: null, statementReviewed: false, creditNote: false, excludedReason: null, classifiedAt: null,
    deletedInPaperlessAt: null, customFields: [], ...structuredClone(d),
  }));
  const writes = [];
  const apply = (r, update) => {
    Object.assign(r, structuredClone(update.$set || {}));
    for (const [k, v] of Object.entries(update.$push || {})) r[k] = [...(r[k] || []), ...(v.$each || [v])];
  };
  return {
    rows,
    writes,
    find: (filter) => ({ select: () => ({ lean: async () => structuredClone(rows.filter(sift(filter))) }) }),
    findOneAndUpdate: (filter, update) => ({
      lean: async () => {
        const r = rows.find(sift(filter));
        if (!r) return null;
        apply(r, update);
        writes.push({ op: 'findOneAndUpdate', filter });
        return structuredClone(r);
      },
    }),
    async updateOne(filter, update) {
      const r = rows.find(sift(filter));
      if (!r) return { modifiedCount: 0 };
      apply(r, update);
      writes.push({ op: 'updateOne', filter });
      return { modifiedCount: 1 };
    },
  };
}

const LogModel = new mongoose.Mongoose().model(NotificationLogDef.modelName, NotificationLogDef.schema);
const uniqueIndexes = NotificationLogDef.schema.indexes().filter(([, o]) => o?.unique);
const inPartial = (row, p) => !p || Object.entries(p).every(([k, v]) => row[k] === v);

function fakeNotificationLog(preexisting = []) {
  const rows = [];
  const api = {
    rows,
    async create(data) {
      const doc = new LogModel(data);
      await doc.validate();
      const row = doc.toObject();
      for (const [keys, opts] of uniqueIndexes) {
        if (!inPartial(row, opts.partialFilterExpression)) continue;
        if (rows.some((r) => inPartial(r, opts.partialFilterExpression) && Object.keys(keys).every((k) => r[k] === row[k]))) {
          const err = new Error('E11000 duplicate key'); err.code = 11000; throw err;
        }
      }
      rows.push(row);
      return row;
    },
    findOne: (filter) => ({ lean: async () => rows.find(sift(filter)) || null }),
    exists: async (filter) => rows.some(sift(filter)),
  };
  return { api, ready: Promise.all(preexisting.map((p) => api.create(p))) };
}

// A Paperless-shaped history: one of each case the backfill has to handle
const HISTORY = [
  { paperlessId: 1, documentType: PI, tags: [T.inbox] },                                    // fresh
  { paperlessId: 2, documentType: PI, tags: [T.dataEntryDone, T.john] },                    // entered, John emailed
  { paperlessId: 3, documentType: PI, tags: [T.added, T.kf, T.john] },                      // in KashFlow
  { paperlessId: 4, documentType: PI, tags: [T.creditSent], customFields: [{ fieldId: 58, value: true }] }, // credit note
  { paperlessId: 5, documentType: PI, tags: [T.originalMulti] },                            // multi-invoice source PDF
  { paperlessId: 6, documentType: PI, tags: [T.manual] },                                   // keyed into KashFlow by hand
  { paperlessId: 7, documentType: SI, tags: [T.added, T.kf] },                              // subcontractor, sent
  { paperlessId: 8, documentType: STATEMENT, tags: [T.statementSent] },                     // statement, Bev emailed
  { paperlessId: 9, documentType: STATEMENT, tags: [] },                                    // statement, not yet
  { paperlessId: 10, documentType: BANK, tags: [t(12, 'bank-statement')] },                 // bank: nothing
  { paperlessId: 11, documentType: PI, tags: [T.added], deletedInPaperlessAt: new Date() }, // deleted: skipped
  { paperlessId: 12, documentType: PI, tags: [T.inbox], processingState: 'awaiting_entry' }, // classified by H3 < 6.45.1
  { paperlessId: 13, documentType: PI, tags: [T.added], processingState: 'entered', classifiedAt: new Date('2026-10-02') }, // hcs-app state wins
  { paperlessId: 14, documentType: PI, tags: [t(8, 'credit/refund')] },                      // legacy credit tag only: not a credit note
];

const now = new Date('2026-10-03T12:00:00Z');

describe('planDocument / sentNotifications (the H7 table)', () => {
  const byId = (id) => HISTORY.find((d) => d.paperlessId === id);

  it('maps each Paperless history to a state and the notifications already sent', () => {
    const cases = {
      1: ['awaiting_entry', []],
      2: ['entered', ['john']],
      3: ['sent', ['kashflow', 'john']],
      4: ['manual_kashflow', ['credit_note']],
      5: ['awaiting_entry', []],
      6: ['awaiting_entry', []],
      7: ['sent', ['kashflow']],
      14: ['awaiting_entry', []],
    };
    for (const [id, [state, kinds]] of Object.entries(cases)) {
      const p = planDocument(byId(Number(id)), { now });
      assert.equal(p.state, state, `#${id} state`);
      assert.deepEqual(p.notifications, kinds, `#${id} notifications`);
    }
    assert.equal(planDocument(byId(5), { now }).classify.result.excludedReason, 'original_multiple');
    assert.equal(planDocument(byId(6), { now }).classify.result.excludedReason, 'manually_added');
  });

  it('classifies statements, reviewed or not, and leaves bank statements alone', () => {
    assert.deepEqual(sentNotifications(byId(8)), ['statement']);
    assert.equal(planDocument(byId(8), { now }).classify.update.$set.statementReviewed, true);
    assert.deepEqual(planDocument(byId(9), { now }).classify.update.$set, { classifiedAt: now });
    const bank = planDocument(byId(10), { now });
    assert.deepEqual([bank.classify, bank.stampClassifiedAt, bank.notifications], [null, false, []]);
  });

  it('never changes a document that already has a state, beyond a missing classifiedAt', () => {
    const p12 = planDocument(byId(12), { now });
    assert.deepEqual([p12.classify, p12.stampClassifiedAt], [null, true]);
    const p13 = planDocument(byId(13), { now });
    assert.deepEqual([p13.classify, p13.stampClassifiedAt, p13.state], [null, false, 'entered']);
  });

  it('labels its history entries as the backfill', () => {
    const h = planDocument(byId(3), { now }).classify.update.$push.processingHistory.$each;
    assert.ok(h.every((e) => e.action === 'backfill' && e.note === BACKFILL_NOTE && e.by.name === 'system'));
  });
});

describe('runBackfill', () => {
  it('a dry run writes nothing and reports what it would do', async () => {
    const M = siftOcrDocument(HISTORY);
    const { api: L } = fakeNotificationLog();
    const s = await runBackfill({ OcrDocument: M, NotificationLog: L, now });
    assert.equal(s.apply, false);
    assert.equal(M.writes.length, 0);
    assert.equal(L.rows.length, 0);
    assert.equal(s.classified, 8);
    assert.match(formatSummary(s), /^DRY RUN/);
  });

  it('applies the H7 table', async () => {
    const M = siftOcrDocument(HISTORY);
    const { api: L } = fakeNotificationLog();
    const s = await runBackfill({ OcrDocument: M, NotificationLog: L, apply: true, now });
    const row = (id) => M.rows.find((r) => r.paperlessId === id);

    assert.deepEqual(s.byState, { awaiting_entry: 4, entered: 1, sent: 2, manual_kashflow: 1 });
    assert.equal(s.classified, 8);
    assert.deepEqual(s.excluded, { original_multiple: 1, manually_added: 1 });
    assert.deepEqual([s.statementsClassified, s.statementsReviewed], [2, 1]);
    assert.equal(s.classifiedAtStamped, 1);
    assert.equal(s.skippedDeleted, 1);
    // #13 keeps its hcs-app state, but its `added` tag means Paperless already announced it
    assert.deepEqual(s.notificationsRecorded, { kashflow: 3, statement: 1, credit_note: 1, john: 2 });

    assert.equal(row(3).processingState, 'sent');
    assert.equal(row(4).creditNote, true);
    assert.equal(row(8).statementReviewed, true);
    assert.ok(row(9).classifiedAt, 'unreviewed statement classified');
    assert.equal(row(10).classifiedAt, null, 'bank statement untouched');
    assert.equal(row(11).processingState, null, 'deleted document untouched');
    assert.deepEqual(row(12).classifiedAt, now);
    assert.equal(row(13).processingState, 'entered', 'hcs-app state kept');
    assert.ok(L.rows.every((r) => r.status === 'recorded' && r.source === 'backfill' && r.mode === null));
  });

  it('running it twice changes nothing the second time', async () => {
    const M = siftOcrDocument(HISTORY);
    const { api: L } = fakeNotificationLog();
    await runBackfill({ OcrDocument: M, NotificationLog: L, apply: true, now });
    const snapshot = JSON.stringify({ rows: M.rows, logs: L.rows.length });
    const writesBefore = M.writes.length;

    const second = await runBackfill({ OcrDocument: M, NotificationLog: L, apply: true, now: new Date('2026-10-04T00:00:00Z') });
    assert.equal(M.writes.length, writesBefore, 'no document written');
    assert.equal(JSON.stringify({ rows: M.rows, logs: L.rows.length }), snapshot);
    assert.equal(second.classified + second.statementsClassified + second.classifiedAtStamped, 0);
    assert.deepEqual(second.notificationsRecorded, { kashflow: 0, statement: 0, credit_note: 0, john: 0 });
    assert.equal(second.alreadyDone, HISTORY.length - 1, 'everything but the deleted one is already done');
  });

  it('does not duplicate a notification already recorded (e.g. in shadow mode)', async () => {
    const M = siftOcrDocument(HISTORY);
    const { api: L, ready } = fakeNotificationLog([{ paperlessId: 3, kind: 'kashflow', status: 'shadow', mode: 'shadow' }]);
    await ready;
    const s = await runBackfill({ OcrDocument: M, NotificationLog: L, apply: true, now });
    assert.equal(s.notificationsAlreadyThere, 1);
    assert.equal(L.rows.filter((r) => r.paperlessId === 3 && r.kind === 'kashflow').length, 1);
  });

  it('after the backfill the hcs-app queues hold exactly what Paperless views 12, 4 and 13 hold', async () => {
    const live = HISTORY.filter((d) => !d.deletedInPaperlessAt && d.paperlessId !== 13 && d.paperlessId !== 12);
    const M = siftOcrDocument(live);
    const { api: L } = fakeNotificationLog();
    await runBackfill({ OcrDocument: M, NotificationLog: L, apply: true, now });

    const isInv = (d) => isDocumentType(d.documentType, 'purchaseInvoice') || isDocumentType(d.documentType, 'subcontractorInvoice');
    const cfCredit = (d) => (d.customFields || []).some((c) => c.fieldId === 58 && c.value === true);
    const paperlessView = {
      // View 12: PI or SI, lacking tags 1, 2, 11, 4 and 22
      'needs-entry': (d) => isInv(d) && !['dataEntryDone', 'added', 'manuallyAddedToKashflow', 'originalMultiInvoice', 'notifiedCreditNote'].some((k) => hasTag(d.tags, k)) && !cfCredit(d),
      // View 4: has tag 1
      ready: (d) => hasTag(d.tags, 'dataEntryDone') && !hasTag(d.tags, 'added'),
      // View 13: Supplier Statement lacking tag 21
      statements: (d) => isDocumentType(d.documentType, 'supplierStatement') && !hasTag(d.tags, 'notifiedAdminStatement'),
    };
    for (const key of queues.QUEUE_KEYS) {
      const ours = M.rows.filter(sift(queues.queueFilter(key))).map((r) => r.paperlessId).sort((a, b) => a - b);
      const theirs = live.filter(paperlessView[key]).map((r) => r.paperlessId).sort((a, b) => a - b);
      assert.deepEqual(ours, theirs, key);
    }
  });
});

describe('H7 wiring', () => {
  it('the script defaults to a dry run and only writes with --apply', () => {
    const src = fs.readFileSync('scripts/paperless-backfill.js', 'utf8');
    assert.match(src, /const APPLY = process\.argv\.includes\('--apply'\)/);
    assert.match(src, /runBackfill\(\{ OcrDocument, NotificationLog, apply: APPLY, log \}\)/);
    assert.ok(!/makeClient|modifyDocumentTags|setDocumentCustomFields|sendMail|notify\(/.test(src), 'never writes to Paperless or sends');
  });
});
