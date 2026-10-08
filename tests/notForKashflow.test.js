import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import entry from '../mongoose/services/paperless/documentEntryService.js';
import { notForEntryMessage } from '../mongoose/services/paperless/documentStateService.js';
import { initialStateFromPaperless, exclusionChange } from '../mongoose/services/paperless/documentIngestService.js';
import queues from '../mongoose/services/paperless/documentQueueService.js';
import { KF_ELIGIBLE_MATCH } from '../mongoose/services/documentsOverviewService.js';

/**
 * Not for KashFlow: a real invoice that's never entered, e.g. one paid with
 * store credit from a refund so the pair nets to nothing (#252/#253).
 * Made-up documents.
 */

const PI = { id: 1, name: 'Purchase Invoice' };
const ADMIN = { userId: null, name: 'test.admin', isAdmin: true };

const setPath = (o, p, v) => {
  const keys = p.split('.');
  let t = o;
  keys.slice(0, -1).forEach((k) => { t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}; t = t[k]; });
  t[keys.at(-1)] = v;
};

function model(rows) {
  const docs = rows.map((r) => ({
    tags: [], customFields: [], processingState: 'entered', creditNote: false, excludedReason: null, excludedNote: null,
    deletedInPaperlessAt: null, documentType: PI, ...structuredClone(r),
  }));
  const q = (fn) => ({ select: () => q(fn), sort: () => q(fn), lean: async () => structuredClone(fn() ?? null) });
  return {
    docs,
    find: (f) => q(() => docs.filter(sift(f))),
    findOne: (f) => q(() => docs.find(sift(f))),
    findOneAndUpdate: (f, u) => q(() => {
      const d = docs.find(sift(f));
      if (!d) return null;
      for (const [k, v] of Object.entries(u.$set || {})) setPath(d, k, structuredClone(v));
      for (const [k, v] of Object.entries(u.$push || {})) d[k] = [...(d[k] || []), ...(v.$each || [v])];
      return d;
    }),
  };
}

// Paperless calls, recorded instead of made
function fakeDeps(fail = false) {
  const calls = [];
  return {
    calls,
    deps: {
      modifyTags: async (id, changes) => { if (fail) throw new Error('down'); calls.push([id, changes]); },
      setFields: async () => {},
      notify: async () => null,
    },
  };
}

const NOTE = 'Paid with refund credit from AR0001; nets to nothing';

describe('Not for KashFlow', () => {
  it('marks an invoice with a reason, out of both queues, and tags Paperless', async () => {
    const M = model([{ paperlessId: 1 }]);
    const { calls, deps } = fakeDeps();
    const r = await entry.setNotForKashflow(M, 1, { flag: true, note: `  ${NOTE} ` }, ADMIN, deps);
    assert.equal(r.ok, true, r.message);
    const d = M.docs[0];
    assert.equal(d.excludedReason, 'not_for_kashflow');
    assert.equal(d.excludedNote, NOTE);
    assert.equal(d.excludedReasonChanged.by.name, 'test.admin');
    assert.equal(d.processingHistory.at(-1).note, NOTE);
    assert.deepEqual(calls, [[1, { add: ['notForKashflow'] }]]);

    for (const key of ['needs-entry', 'ready']) assert.equal(M.docs.filter(sift(queues.queueFilter(key))).length, 0, key);
    assert.equal(sift({ excludedReason: KF_ELIGIBLE_MATCH.excludedReason })(d), false, 'not on the overview as never sent');
    assert.match(notForEntryMessage(d), /not for KashFlow.*Reason: Paid with refund credit/);
  });

  it('needs a reason, and only for an invoice still being worked on', async () => {
    const M = model([
      { paperlessId: 1 },
      { paperlessId: 2, processingState: 'sent' },
      { paperlessId: 3, processingState: 'manual_kashflow', creditNote: true },
      { paperlessId: 4, excludedReason: 'original_multiple' },
      { paperlessId: 5, documentType: { id: 2, name: 'Supplier Statement' }, processingState: null },
    ]);
    const { calls, deps } = fakeDeps();
    const why = async (id, note = NOTE) => (await entry.setNotForKashflow(M, id, { flag: true, note }, ADMIN, deps)).reason;
    assert.equal(await why(1, ' '), 'no-note');
    assert.equal(await why(1, 'x'.repeat(entry.NOT_FOR_KASHFLOW_NOTE_MAX + 1)), 'long-note');
    assert.equal(await why(2), 'sent');
    assert.equal(await why(3), 'state');
    assert.equal(await why(4), 'excluded');
    assert.equal(await why(5), 'not-invoice');
    assert.equal(calls.length, 0);
    assert.equal(M.docs[0].excludedReason, null);
  });

  it('undo puts it back in its queue and untags Paperless', async () => {
    const M = model([{ paperlessId: 1 }]);
    const { calls, deps } = fakeDeps();
    await entry.setNotForKashflow(M, 1, { flag: true, note: NOTE }, ADMIN, deps);
    const r = await entry.setNotForKashflow(M, 1, { flag: false }, ADMIN, deps);
    assert.equal(r.ok, true, r.message);
    assert.equal(M.docs[0].excludedReason, null);
    assert.equal(M.docs[0].excludedNote, null);
    assert.deepEqual(calls.at(-1), [1, { remove: ['notForKashflow'] }]);
    assert.equal(M.docs.filter(sift(queues.queueFilter('ready'))).length, 1);
    assert.equal((await entry.setNotForKashflow(M, 1, { flag: false }, ADMIN, deps)).reason, 'not-marked');
  });

  it('still marks it when Paperless is down, and says what to do by hand', async () => {
    const M = model([{ paperlessId: 1 }]);
    const r = await entry.setNotForKashflow(M, 1, { flag: true, note: NOTE }, ADMIN, fakeDeps(true).deps);
    assert.equal(r.ok, true);
    assert.equal(M.docs[0].excludedReason, 'not_for_kashflow');
    assert.match(r.paperlessWarning, /Add the "not for kashflow" tag in Paperless/);
  });

  it('follows the tag from Paperless, and keeps a person\'s mark when the tag is missing', () => {
    const tagged = { documentType: PI, processingState: 'awaiting_entry', tags: [{ id: 99, name: 'not for kashflow' }] };
    assert.equal(initialStateFromPaperless(tagged).excludedReason, 'not_for_kashflow');
    assert.deepEqual(exclusionChange({ ...tagged, excludedReason: null }), { from: null, to: 'not_for_kashflow' });
    // Marked here, tag not added yet (Paperless was down): not undone
    const marked = { documentType: PI, processingState: 'entered', tags: [], excludedReason: 'not_for_kashflow', excludedReasonChanged: { by: { name: 'test.admin' } } };
    assert.equal(exclusionChange(marked), null);
    assert.match(notForEntryMessage({ excludedReason: 'not_for_kashflow' }), /^Marked not for KashFlow/);
  });

  it('is wired: route, admin permission, entry and details screens', () => {
    const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
    assert.match(read('mongoose/routes/paperlessRoutes.js'), /post\("\/paperless\/ocr\/:paperlessId\/not-for-kashflow", \.\.\.paperlessGuard, entryCtrl\.postNotForKashflow\)/);
    assert.match(read('mongoose/config/rolePermissionsConfig.js'), /'\/paperless\/ocr\/:paperlessId\/not-for-kashflow': \['admin'\]/);
    assert.match(read('mongoose/views/tailwindcss/paperless/entry.ejs'), /action="\/paperless\/ocr\/<%= doc\.paperlessId %>\/not-for-kashflow"/);
    assert.match(read('mongoose/views/tailwindcss/paperless/read.ejs'), /data-not-for-kashflow/);
  });
});

describe('a tag with no configured id (mock Paperless)', () => {
  let mock;
  let modifyPaperlessDocumentTags;
  before(async () => {
    process.env.PAPERLESS_URL = 'mock';
    mock = await import('../mongoose/services/paperless/mock/paperlessMockClient.js');
    ({ modifyPaperlessDocumentTags } = await import('../mongoose/services/paperless/paperlessUpdateService.js'));
  });
  after(() => { delete process.env.PAPERLESS_URL; });
  beforeEach(() => mock.resetMockPaperless());

  it('is created on first use, then found by name, and removed again', async () => {
    const state = () => mock.mockPaperlessState();
    const docId = state().documents[0].id;
    const before = state().tags.length;
    await modifyPaperlessDocumentTags(docId, { add: ['notForKashflow'] });
    const tag = state().tags.find((t) => t.name === 'not for kashflow');
    assert.ok(tag, 'created');
    assert.equal(state().tags.length, before + 1);
    assert.ok(state().documents[0].tags.includes(tag.id));

    await modifyPaperlessDocumentTags(docId, { add: ['notForKashflow'] });
    assert.equal(state().tags.length, before + 1, 'found by name, not made twice');

    await modifyPaperlessDocumentTags(docId, { remove: ['notForKashflow'] });
    assert.ok(!state().documents[0].tags.includes(tag.id));
  });

  it("removing a tag that was never made changes nothing", async () => {
    const r = await modifyPaperlessDocumentTags(mock.mockPaperlessState().documents[0].id, { remove: ['notForKashflow'] });
    assert.deepEqual(r, { updated: false });
  });
});
