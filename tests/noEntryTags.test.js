import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sift from 'sift';

import ingest from '../mongoose/services/paperless/documentIngestService.js';
import queues from '../mongoose/services/paperless/documentQueueService.js';
import entry from '../mongoose/services/paperless/documentEntryService.js';
import { notForEntryMessage } from '../mongoose/services/paperless/documentStateService.js';
import { sendBlockedMessage } from '../mongoose/controllers/paperlessController.js';

/**
 * Paperless tags that mean "don't enter this": 4 original/multiple invoice one
 * pdf and 11 manually added to kashflow. Until 6.54.0 they only counted when
 * the document first arrived, and nothing stopped entry or the send.
 */

const PI = { id: 1, name: 'Purchase Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const T = {
  originalMulti: { id: 4, name: 'original/multiple invoice one pdf' },
  manual: { id: 11, name: 'manually added to kashflow' },
  inbox: { id: 3, name: 'inbox' },
};
const PERSON = { userId: '64b000000000000000000001', name: 'jack' };

// Enough of OcrDocument for the services, with real Mongo matching
function model(rows) {
  const docs = rows.map((r) => ({
    documentType: PI, tags: [], customFields: [], processingState: 'awaiting_entry',
    excludedReason: null, excludedReasonChanged: null, deletedInPaperlessAt: null, ...structuredClone(r),
  }));
  const q = (fn) => ({ select: () => q(fn), sort: () => q(fn), lean: async () => structuredClone(fn()) });
  return {
    docs,
    find: (f) => q(() => docs.filter(sift(f))),
    findOne: (f) => q(() => docs.find(sift(f)) || null),
    findOneAndUpdate: (f, u) => q(() => {
      const d = docs.find(sift(f));
      if (!d) return null;
      Object.assign(d, u.$set || {});
      for (const [k, v] of Object.entries(u.$push || {})) d[k] = [...(d[k] || []), ...(v.$each || [v])];
      return d;
    }),
  };
}

describe('following the no-entry tags', () => {
  const change = (extra) => ingest.exclusionChange({ documentType: PI, processingState: 'awaiting_entry', tags: [], excludedReason: null, ...extra });

  it('a tag added after the invoice arrived excludes it', () => {
    assert.deepEqual(change({ tags: [T.originalMulti] }), { from: null, to: 'original_multiple' });
    assert.deepEqual(change({ processingState: 'entered', tags: [T.manual] }), { from: null, to: 'manually_added' });
  });

  it('removing the tag lets it back in, unless a person excluded it', () => {
    assert.deepEqual(change({ excludedReason: 'manually_added', excludedReasonChanged: { by: { userId: null, name: 'system' } } }), { from: 'manually_added', to: null });
    assert.deepEqual(change({ excludedReason: 'manually_added' }), { from: 'manually_added', to: null });
    assert.equal(change({ excludedReason: 'manually_added', excludedReasonChanged: { by: PERSON } }), null);
  });

  it('leaves sent invoices, credit notes, statements and deleted documents alone', () => {
    assert.equal(change({ processingState: 'sent', tags: [T.manual] }), null);
    assert.equal(change({ processingState: 'manual_kashflow', tags: [T.manual] }), null);
    assert.equal(change({ documentType: STATEMENT, processingState: null, tags: [T.manual] }), null);
    assert.equal(change({ tags: [T.manual], deletedInPaperlessAt: new Date() }), null);
    assert.equal(change({ tags: [T.inbox] }), null);
  });

  it('the sweep puts every waiting invoice right, records it, and is idempotent', async () => {
    const m = model([
      { paperlessId: 1, tags: [T.originalMulti] },
      { paperlessId: 2, processingState: 'entered', tags: [T.manual] },
      { paperlessId: 3, tags: [T.inbox] },
      { paperlessId: 4, excludedReason: 'manually_added', tags: [] },
      { paperlessId: 5, processingState: 'sent', tags: [T.manual] },
      { paperlessId: 6, tags: [{ id: 99, name: 'Manually Added to KashFlow' }] }, // recreated tag, new id
    ]);
    const r = await ingest.applyExclusionTags(m);
    assert.deepEqual(r, { excluded: [1, 2, 6], cleared: [4] });
    assert.deepEqual(m.docs.map((d) => d.excludedReason), ['original_multiple', 'manually_added', null, null, null, 'manually_added']);
    const h = m.docs[0].processingHistory.at(-1);
    assert.equal(h.action, 'set_excluded');
    assert.equal(h.by.name, 'system');
    assert.deepEqual(await ingest.applyExclusionTags(m), { excluded: [], cleared: [] });
  });

  it('runs on every ingest of a document hcs-app already has, and as a job', async () => {
    const m = model([{ paperlessId: 7, tags: [T.manual], classifiedAt: new Date() }]);
    const r = await ingest.syncDocument(m, 7, { notify: async () => {} });
    assert.deepEqual(r.exclusion, { from: null, to: 'manually_added' });
    const jobs = fs.readFileSync(path.resolve('mongoose/services/jobRegistry.js'), 'utf8');
    assert.match(jobs, /scheduler\.register\('paperless-exclusion-tags'/);
    assert.match(jobs, /applyExclusionTags\(__mdbForJobs\.PAPERLESS\.OcrDocument\)/);
  });
});

describe('an excluded invoice is not entered or sent', () => {
  const ids = (key, rows) => rows.filter(sift(queues.queueFilter(key))).map((r) => r.paperlessId);
  const base = { documentType: PI, deletedInPaperlessAt: null };

  it('is in neither invoice queue', () => {
    const rows = [
      { ...base, paperlessId: 1, processingState: 'entered', excludedReason: 'manually_added' },
      { ...base, paperlessId: 2, processingState: 'entered', excludedReason: null },
    ];
    assert.deepEqual(ids('ready', rows), [2]);
  });

  it("can't be completed", async () => {
    const m = model([{ paperlessId: 1, excludedReason: 'original_multiple', entry: { savedAt: new Date() } }]);
    const r = await entry.completeEntry(m, 1, null, { notify: async () => {}, modifyTags: async () => {} });
    assert.equal(r.reason, 'excluded');
    assert.match(r.message, /several invoices/);
    assert.equal(m.docs[0].processingState, 'awaiting_entry');
  });

  it("can't be drafted or sent, nor can a credit note", () => {
    assert.match(sendBlockedMessage({ documentType: PI, processingState: 'entered', excludedReason: 'manually_added' }), /keyed into KashFlow by hand/);
    assert.match(sendBlockedMessage({ documentType: PI, processingState: 'manual_kashflow' }), /credit note/);
    assert.match(sendBlockedMessage({ documentType: STATEMENT }), /Supplier statements/);
    assert.equal(sendBlockedMessage({ documentType: PI, processingState: 'entered', excludedReason: null }), null);
    assert.equal(notForEntryMessage({ excludedReason: null }), null);
  });

  it('the entry screen is read-only and refuses saves', () => {
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/documentEntryController.js'), 'utf8');
    assert.match(ctrl, /locked: doc\.processingState === 'sent' \|\| !!notForEntryMessage\(doc\)/);
    assert.match(ctrl, /const excluded = notForEntryMessage\(doc\);\s*if \(excluded\) \{\s*req\.flash\('error', excluded\);/);
  });
});

describe('the KashFlow draft page', () => {
  it('links back to its queue and to the entry screen', () => {
    const view = fs.readFileSync(path.resolve('mongoose/views/tailwindcss/paperless/draft.ejs'), 'utf8');
    assert.match(view, /href="\/paperless\/queues\/<%= _queueBack\.key %>"/);
    assert.match(view, /Ready for KashFlow/);
    assert.match(view, /href="\/paperless\/ocr\/<%= paperlessId %>\/entry"[^>]*>.*Edit entry<\/a>/);
  });
});
