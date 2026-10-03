import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sift from 'sift';

import shadow from '../mongoose/services/paperless/shadowReportService.js';

const { compareWindow, saveDailyReport, dayWindow, COMPARED_KINDS } = shadow;
const ejs = createRequire(import.meta.url)('ejs');

/** H8: shadow comparison (PAPERLESS-MIGRATION.md H8). */

const PI = { id: 1, name: 'Purchase Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const t = (id, name) => ({ id, name });
const TAG = { john: t(19, 'notified/john'), kf: t(20, 'notified/kashflow'), stmt: t(21, 'notified/admin-statement'), cn: t(22, 'notified/credit-note') };

const now = new Date('2026-10-10T12:00:00Z');
const from = new Date('2026-10-09T12:00:00Z');
const hoursAgo = (h) => new Date(now.getTime() - h * 3_600_000);
const minsAgo = (m) => new Date(now.getTime() - m * 60_000);

const chain = (list) => {
  let out = list;
  const c = {
    select() { return c; },
    sort(spec) { const [[k, d]] = Object.entries(spec); out = [...out].sort((a, b) => (a[k] > b[k] ? d : -d)); return c; },
    limit(n) { out = out.slice(0, n); return c; },
    lean: async () => structuredClone(out),
  };
  return c;
};
const siftModel = (rows) => ({ rows, find: (f) => chain(rows.filter(sift(f))) });

const doc = (paperlessId, extra = {}) => ({
  paperlessId, title: `Doc ${paperlessId}`, correspondent: { name: 'Acme' }, documentType: PI,
  created: new Date('2026-10-01'), added: new Date('2026-09-01'), modified: hoursAgo(5), tags: [], deletedInPaperlessAt: null, ...extra,
});
const row = (paperlessId, kind, extra = {}) => ({ paperlessId, kind, source: 'app', status: 'shadow', createdAt: hoursAgo(4), ...extra });

const bucketIds = (r, kind, bucket) => r.kinds[kind][bucket].map((i) => i.paperlessId).sort((a, b) => a - b);

describe('compareWindow', () => {
  it('matches a Paperless send to hcs-app\'s record, including across the window edge', async () => {
    const docs = [doc(1, { tags: [TAG.john] }), doc(2, { tags: [TAG.kf] })];
    const logs = [row(1, 'john'), row(2, 'kashflow', { createdAt: hoursAgo(30) })]; // recorded before the window
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel(logs), from, to: now, now });
    assert.deepEqual(bucketIds(r, 'john', 'matched'), [1]);
    assert.deepEqual(bucketIds(r, 'kashflow', 'matched'), [2]);
    assert.equal(r.clean, true);
  });

  it('flags Paperless sends hcs-app missed, unless they are too recent to judge', async () => {
    const docs = [doc(3, { tags: [TAG.kf] }), doc(4, { tags: [TAG.stmt], documentType: STATEMENT, modified: minsAgo(5) })];
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel([]), from, to: now, now });
    assert.deepEqual(bucketIds(r, 'kashflow', 'missing'), [3]);
    assert.deepEqual(bucketIds(r, 'statement', 'pending'), [4]);
    assert.equal(r.clean, false);
    assert.match(r.kinds.kashflow.missing[0].wouldSend, /^Document added to kashflow: Doc 3 - /);
  });

  it('flags hcs-app sends with no sign of Paperless sending, unless just recorded', async () => {
    const docs = [doc(5), doc(6)];
    const logs = [row(5, 'credit_note'), row(6, 'credit_note', { createdAt: minsAgo(10) })];
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel(logs), from, to: now, now });
    assert.deepEqual(bucketIds(r, 'credit_note', 'extra'), [5]);
    assert.deepEqual(bucketIds(r, 'credit_note', 'pending'), [6]);
    assert.equal(r.kinds.credit_note.extra[0].source, 'app');
  });

  it('leaves backfill history out, and ignores sends outside the window', async () => {
    const docs = [
      doc(7, { tags: [TAG.cn] }),                                   // tagged before the shadow run
      doc(8, { tags: [TAG.kf], modified: hoursAgo(48) }),           // outside the window
    ];
    const logs = [row(7, 'credit_note', { source: 'backfill', status: 'recorded', createdAt: hoursAgo(200) })];
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel(logs), from, to: now, now });
    for (const k of Object.keys(COMPARED_KINDS)) {
      const kk = r.kinds[k];
      assert.equal(kk.matched.length + kk.missing.length + kk.extra.length + kk.pending.length, 0, k);
    }
    assert.equal(r.clean, true);
  });

  it('compares new-document posts by when each document was added', async () => {
    const docs = [doc(9, { added: hoursAgo(3) }), doc(10, { added: hoursAgo(2) }), doc(11, { added: minsAgo(3) })];
    const logs = [row(9, 'new_doc')];
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel(logs), from, to: now, now });
    assert.deepEqual(bucketIds(r, 'new_doc', 'matched'), [9]);
    assert.deepEqual(bucketIds(r, 'new_doc', 'missing'), [10]);
    assert.deepEqual(bucketIds(r, 'new_doc', 'pending'), [11]);
  });

  it('counts re-sends, and a re-send satisfies the john tag', async () => {
    const docs = [doc(12, { tags: [TAG.john] })];
    const logs = [row(12, 'john_resend'), row(12, 'john_resend', { createdAt: hoursAgo(1) })];
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel(logs), from, to: now, now });
    assert.equal(r.resends, 2);
    assert.deepEqual(bucketIds(r, 'john', 'matched'), [12]);
  });

  it('ignores documents deleted in Paperless', async () => {
    const docs = [doc(13, { tags: [TAG.kf], deletedInPaperlessAt: hoursAgo(1) })];
    const r = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel([]), from, to: now, now });
    assert.equal(r.kinds.kashflow.missing.length, 0);
  });
});

describe('saveDailyReport', () => {
  it('saves yesterday (UTC) and replaces it when run again', async () => {
    const saved = new Map();
    const ShadowReport = {
      updateOne: async (filter, update) => { saved.set(filter.day, update.$set); return { upsertedCount: 1 }; },
    };
    const docs = [doc(3, { tags: [TAG.kf], modified: new Date('2026-10-09T10:00:00Z') })];
    const r1 = await saveDailyReport({ OcrDocument: siftModel(docs), NotificationLog: siftModel([]), ShadowReport, now });
    assert.equal(r1.day, '2026-10-09');
    assert.equal(saved.get('2026-10-09').clean, false);
    const logs = [row(3, 'kashflow', { createdAt: new Date('2026-10-09T10:05:00Z') })];
    await saveDailyReport({ OcrDocument: siftModel(docs), NotificationLog: siftModel(logs), ShadowReport, now });
    assert.equal(saved.size, 1);
    assert.equal(saved.get('2026-10-09').clean, true);
    assert.deepEqual(dayWindow('2026-10-09'), { from: new Date('2026-10-09T00:00:00Z'), to: new Date('2026-10-10T00:00:00Z') });
  });
});

describe('shadow report page', () => {
  it('shows the totals, what to look at, the daily reports and the cutover steps', async () => {
    const docs = [doc(3, { tags: [TAG.kf] }), doc(1, { tags: [TAG.john] })];
    const live = await compareWindow({ OcrDocument: siftModel(docs), NotificationLog: siftModel([row(1, 'john')]), from, to: now, now });
    const view = path.resolve('mongoose/views/tailwindcss/paperless/shadowReport.ejs');
    const html = await ejs.renderFile(view, {
      days: 1, live, followTags: true, paperlessUiBase: 'https://docs.example.test',
      saved: [{ day: '2026-10-09', clean: true, mode: 'shadow', totals: { matched: 4, missing: 0, extra: 0 } }],
    });
    assert.match(html, /1 mismatch/);
    assert.match(html, /Added to KashFlow \(Discord\): Paperless sent, hcs-app recorded nothing/);
    assert.match(html, /href="\/paperless\/ocr\/3\/entry"/);
    assert.match(html, /2026-10-09/);
    assert.match(html, /disable workflows 2, 3, 4, 5, 8 and 9/);
    assert.ok(!/<script/i.test(fs.readFileSync(view, 'utf8')));
  });
});

describe('H8 wiring', () => {
  const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
  it('route, RBAC, daily job and the link from the queues', () => {
    assert.ok(read('mongoose/routes/paperlessRoutes.js').includes('router.get("/paperless/shadow-report", ...paperlessGuard, shadowCtrl.getShadowReport)'));
    assert.match(read('mongoose/config/rolePermissionsConfig.js'), /'\/paperless\/shadow-report':\s+\['admin'\]/);
    assert.match(read('mongoose/services/jobRegistry.js'), /scheduler\.register\('paperless-shadow-report'/);
    assert.match(read('mongoose/views/tailwindcss/paperless/queue.ejs'), /href="\/paperless\/shadow-report"/);
  });
});
