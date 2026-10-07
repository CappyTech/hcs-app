import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import sift from 'sift';

process.env.PAPERLESS_URL = 'mock';

import typeCheck from '../mongoose/services/paperless/documentTypeCheck.js';
import typeSvc from '../mongoose/services/paperless/documentTypeService.js';
import queues from '../mongoose/services/paperless/documentQueueService.js';
import { backUrl, changedMessage } from '../mongoose/controllers/documentTypeController.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';

const require = createRequire(import.meta.url);
const ejs = require('ejs');
const { typeConcern, buildTypeCheck, sweepTypeChecks, confirmType, refreshTypeCheck } = typeCheck;
const { makeMockClient, resetMockPaperless, mockPaperlessState } = mockPaperless;

/** Changing a document's type from hcs-app, and the Check the type queue. */

const PI = { id: 1, name: 'Purchase Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const NOW = new Date('2026-10-08T12:00:00Z');
const JACK = { userId: null, name: 'jack.oldfield', isAdmin: true };

const setPath = (o, p, v) => {
  const keys = p.split('.');
  let t = o;
  keys.slice(0, -1).forEach((k) => { t[k] = t[k] && typeof t[k] === 'object' ? t[k] : {}; t = t[k]; });
  t[keys.at(-1)] = v;
};

// OcrDocument with real Mongo matching, dotted $set and $push $each
function model(rows) {
  const docs = rows.map((r) => ({
    tags: [], customFields: [], processingState: null, classifiedAt: null, statementReviewed: false, creditNote: false,
    excludedReason: null, deletedInPaperlessAt: null, added: new Date('2026-10-01T00:00:00Z'), ...structuredClone(r),
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

describe('does it look like its type?', () => {
  const inv = (ocrText, extra = {}) => typeConcern({ documentType: PI, processingState: 'awaiting_entry', ocrText, ...extra });

  it('no type at all', () => {
    assert.equal(typeConcern({ documentType: null }).code, 'untyped');
    assert.equal(typeConcern({}).code, 'untyped');
  });

  it('an "invoice" that reads like a statement, remittance or credit note', () => {
    assert.equal(inv('STARK Building Materials  STATEMENT OF ACCOUNT  Account HERO713').code, 'looks-statement');
    assert.equal(inv('REMITTANCE ADVICE  Payment of £1,200.00').code, 'looks-remittance');
    assert.equal(inv('CREDIT NOTE  Credit No: CN-0042  Original invoice 0767/08027611').code, 'looks-credit-note');
    assert.equal(inv('CREDIT NOTE', { creditNote: true }), null, 'already flagged');
  });

  it('a real invoice is fine, even one that mentions a statement lower down', () => {
    assert.equal(inv('SALES INVOICE  Invoice No: 0767/08027611'), null);
    assert.equal(inv('SALES INVOICE Invoice No 1 ' + 'x '.repeat(500) + 'refer to the reverse of your statement'), null);
  });

  it('an invoice the reader found nothing on', () => {
    const r = (fields) => ({ hasText: true, fields });
    assert.equal(inv('Some text', { reading: r({}) }).code, 'nothing-read');
    assert.equal(inv('Some text', { reading: r({ invoiceTotal: { value: '85.86' } }) }), null);
    assert.equal(inv('Some text', { reading: { hasText: false, fields: {} } }), null, 'no text layer is its own problem');
  });

  it('only while the invoice is being worked on', () => {
    assert.equal(inv('STATEMENT', { processingState: 'sent' }), null);
    assert.equal(inv('STATEMENT', { processingState: 'manual_kashflow' }), null);
  });

  it('a "statement" that reads like an invoice', () => {
    const st = (ocrText, extra = {}) => typeConcern({ documentType: STATEMENT, ocrText, ...extra });
    assert.equal(st('TAX INVOICE  Invoice No 123  Total 85.86').code, 'looks-invoice');
    assert.equal(st('STATEMENT  Invoice 123  Invoice 124'), null);
    assert.equal(st('TAX INVOICE', { statementReviewed: true }), null);
  });
});

describe('the Check the type queue', () => {
  it('lists a concern until someone marks the type as right; a different concern shows again', async () => {
    const M = model([
      { paperlessId: 1, documentType: PI, processingState: 'awaiting_entry', ocrText: 'STATEMENT OF ACCOUNT' },
      { paperlessId: 2, documentType: PI, processingState: 'awaiting_entry', ocrText: 'SALES INVOICE' },
      { paperlessId: 3, documentType: null, added: new Date('2026-10-05') },
      { paperlessId: 4, documentType: null, added: new Date('2025-01-01') }, // history, not work
      { paperlessId: 5, documentType: PI, processingState: 'sent', ocrText: 'STATEMENT' },
    ]);
    assert.deepEqual(await sweepTypeChecks(M, { now: NOW }), { checked: 3, open: 2 });
    const listed = () => M.docs.filter(sift(queues.queueFilter('check-type'))).map((d) => d.paperlessId);
    assert.deepEqual(listed(), [1, 3]);

    assert.deepEqual(await confirmType(M, 1, JACK, { now: NOW }), { ok: true, changed: true });
    assert.deepEqual(listed(), [3]);
    assert.equal(M.docs[0].typeCheck.confirmed.by.name, 'jack.oldfield');
    await sweepTypeChecks(M, { now: NOW });
    assert.deepEqual(listed(), [3], 'stays dismissed');

    M.docs[0].ocrText = 'REMITTANCE ADVICE';
    await refreshTypeCheck(M, 1, { now: NOW });
    assert.deepEqual(listed(), [1, 3], 'a different concern');

    assert.equal((await confirmType(M, 3, JACK)).reason, 'untyped', 'no type to be right');
  });

  it('closes when the document moves on', async () => {
    const M = model([{ paperlessId: 1, documentType: PI, processingState: 'awaiting_entry', ocrText: 'STATEMENT' }]);
    await sweepTypeChecks(M, { now: NOW });
    M.docs[0].processingState = 'sent';
    await sweepTypeChecks(M, { now: NOW });
    assert.equal(M.docs[0].typeCheck.open, false);
  });

  it('builds the stored check', () => {
    const c = buildTypeCheck({ documentType: null, added: NOW }, NOW);
    assert.deepEqual({ ...c, at: undefined }, { version: 1, at: undefined, concern: { code: 'untyped', message: "It has no document type, so it isn't in any queue." }, open: true, confirmed: null });
  });
});

describe('changing the type', () => {
  let api;
  let read;
  const deps = () => ({ api, ingestOne: async () => {}, readSoon: async (id) => { read.push(id); } });
  beforeEach(() => {
    resetMockPaperless();
    typeSvc.clearTypeCache();
    api = makeMockClient();
    read = [];
  });
  const patches = () => mockPaperlessState().calls.filter((c) => c.method === 'PATCH');

  it('a statement that came in as a Purchase Invoice moves to Statements to Review, and Paperless is told', async () => {
    const M = model([{ paperlessId: 9001, documentType: PI, processingState: 'awaiting_entry', classifiedAt: NOW, ocrText: 'STATEMENT OF ACCOUNT' }]);
    const r = await typeSvc.changeDocumentType(M, 9001, 2, JACK, deps(), { now: NOW });
    assert.deepEqual(r, { ok: true, changed: true, from: 'Purchase Invoice', to: 'Supplier Statement', state: null });
    const d = M.docs[0];
    assert.deepEqual(d.documentType, STATEMENT);
    assert.equal(d.processingState, null);
    assert.ok(d.classifiedAt, 'classified again as a statement');
    assert.deepEqual(M.docs.filter(sift(queues.queueFilter('statements'))).map((x) => x.paperlessId), [9001]);
    assert.deepEqual(M.docs.filter(sift(queues.queueFilter('needs-entry'))), []);
    assert.deepEqual(d.processingHistory.map((h) => [h.field, h.from, h.to, h.action, h.by?.name]), [
      ['documentType', 'Purchase Invoice', 'Supplier Statement', 'change_type', 'jack.oldfield'],
      ['processingState', 'awaiting_entry', null, 'change_type', 'jack.oldfield'],
    ]);
    assert.deepEqual(patches().map((c) => c.body), [{ document_type: 2 }]);
    assert.equal(mockPaperlessState().documents.find((x) => x.id === 9001).document_type, 2);
  });

  it('an untyped upload typed as an invoice joins Needs Data Entry and gets read', async () => {
    const M = model([{ paperlessId: 9001, documentType: null }]);
    const r = await typeSvc.changeDocumentType(M, 9001, 1, JACK, deps(), { now: NOW });
    assert.equal(r.state, 'awaiting_entry');
    assert.deepEqual(read, [9001]);
    assert.equal(M.docs[0].typeCheck.open, false);
    assert.equal(changedMessage(r), "Type changed to Purchase Invoice. It's in Needs Data Entry.");
  });

  it('Purchase ↔ Subcontractor Invoice keeps the state and what was entered', async () => {
    const M = model([{ paperlessId: 9001, documentType: PI, processingState: 'entered', entry: { invoiceNumber: 'A1' } }]);
    const r = await typeSvc.changeDocumentType(M, 9001, 3, JACK, deps(), { now: NOW });
    assert.equal(r.state, 'entered');
    assert.deepEqual(M.docs[0].documentType, SI);
    assert.equal(M.docs[0].entry.invoiceNumber, 'A1');
    assert.deepEqual(M.docs[0].processingHistory.map((h) => h.field), ['documentType']);
  });

  it('refuses an invoice already in KashFlow, an unknown type, and does nothing for the same type', async () => {
    const M = model([
      { paperlessId: 9001, documentType: PI, processingState: 'sent', kashflowPurchaseId: 14937, kashflowPurchaseNumber: 1234 },
      { paperlessId: 9002, documentType: PI, processingState: 'awaiting_entry' },
    ]);
    const sent = await typeSvc.changeDocumentType(M, 9001, 2, JACK, deps());
    assert.equal(sent.reason, 'in-kashflow');
    assert.match(sent.message, /purchase #1234\. Unlink it/);
    assert.equal((await typeSvc.changeDocumentType(M, 9002, 99, JACK, deps())).reason, 'invalid-type');
    assert.deepEqual(await typeSvc.changeDocumentType(M, 9002, 1, JACK, deps()), { ok: true, changed: false, to: 'Purchase Invoice' });
    assert.deepEqual(patches(), [], 'Paperless untouched');
  });

  it('lists the Paperless types, falling back to the known ones when Paperless is down', async () => {
    assert.deepEqual((await typeSvc.documentTypeOptions({ api })).map((t) => t.name),
      ['Bank Statement', 'Purchase Invoice', 'Remittance Advice', 'Subcontractor Invoice', 'Supplier Statement']);
    const down = { listDocumentTypes: async () => { throw new Error('ECONNREFUSED'); } };
    assert.deepEqual((await typeSvc.documentTypeOptions({ api: down })).map((t) => t.id).sort(), [1, 2, 3, 4]);
  });
});

describe('type picker and concern on the pages', () => {
  const partial = path.resolve('mongoose/views/tailwindcss/partials/_documentType.ejs');
  const types = [PI, STATEMENT, SI];
  const render = (doc, back = 'entry') => ejs.renderFile(partial, { doc: { paperlessId: 7, ...doc }, documentTypes: types, back, csrfToken: 't' });

  it('offers every type, the current one selected, and posts to Paperless via hcs-app', async () => {
    const html = await render({ documentType: PI, processingState: 'awaiting_entry' });
    assert.match(html, /action="\/paperless\/ocr\/7\/type"/);
    assert.match(html, /<option value="1" selected>Purchase Invoice<\/option>/);
    assert.match(html, /<option value="2" >Supplier Statement<\/option>/);
    assert.match(html, /name="back" value="entry"/);
    assert.match(html, /name="_csrf" value="t"/);
  });

  it('shows the concern with "The type is right", but not for a document with no type', async () => {
    const concern = { code: 'looks-statement', message: 'It reads like a supplier statement.' };
    const html = await render({ documentType: PI, processingState: 'awaiting_entry', typeCheck: { open: true, concern } });
    assert.match(html, /Check the type\.<\/strong> It reads like a supplier statement\./);
    assert.match(html, /action="\/paperless\/ocr\/7\/type-confirmed"/);
    const untyped = await render({ documentType: null, typeCheck: { open: true, concern: { code: 'untyped', message: 'No type.' } } });
    assert.match(untyped, /Choose a type…/);
    assert.ok(!untyped.includes('type-confirmed'));
  });

  it("can't change an invoice in KashFlow", async () => {
    const html = await render({ documentType: PI, processingState: 'sent', kashflowPurchaseId: 1 });
    assert.ok(!html.includes('/type"'));
    assert.match(html, /in KashFlow, so the type can't change/);
  });

  it('is on the entry and details pages, and the queue lists why', () => {
    const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
    assert.match(read('mongoose/views/tailwindcss/paperless/entry.ejs'), /include\('\.\.\/partials\/_documentType', \{ doc, documentTypes: locals\.documentTypes, back: 'entry' \}\)/);
    assert.match(read('mongoose/views/tailwindcss/paperless/read.ejs'), /include\('\.\.\/partials\/_documentType', \{ doc, documentTypes: locals\.documentTypes, back: 'details' \}\)/);
    assert.match(read('mongoose/views/tailwindcss/paperless/queue.ejs'), /d\.typeCheck\?\.concern\?\.message/);
  });
});

describe('wiring', () => {
  it('routes are admin-only and go back where they came from', () => {
    const routes = fs.readFileSync(path.resolve('mongoose/routes/paperlessRoutes.js'), 'utf8');
    assert.match(routes, /router\.post\("\/paperless\/ocr\/:paperlessId\/type", \.\.\.paperlessGuard, typeCtrl\.postType\)/);
    assert.match(routes, /router\.post\("\/paperless\/ocr\/:paperlessId\/type-confirmed", \.\.\.paperlessGuard, typeCtrl\.postTypeConfirmed\)/);
    const src = fs.readFileSync(path.resolve('mongoose/config/rolePermissionsConfig.js'), 'utf8');
    assert.match(src, /'\/paperless\/ocr\/:paperlessId\/type':\s+\['admin'\]/);
    assert.match(src, /'\/paperless\/ocr\/:paperlessId\/type-confirmed': \['admin'\]/);
    assert.equal(backUrl('details', 7), '/paperless/ocr/7');
    assert.equal(backUrl('check-type', 7), '/paperless/queues/check-type');
    assert.equal(backUrl('https://evil.example', 7), '/paperless/ocr/7/entry');
  });

  it('checks on every ingest and reading, and hourly', () => {
    const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
    assert.match(read('mongoose/services/paperless/documentIngestService.js'), /await refreshTypeCheck\(OcrDocument, paperlessId, \{ now \}\)/);
    assert.match(read('mongoose/services/paperless/documentReadingService.js'), /await refreshTypeCheck\(OcrDocument, paperlessId\)/);
    assert.match(read('mongoose/services/jobRegistry.js'), /scheduler\.register\('paperless-type-check'/);
  });
});
