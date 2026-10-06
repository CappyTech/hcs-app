import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf } from './helpers/makePdf.js';
import { memoryModel } from './helpers/memoryModel.js';
import svc from '../mongoose/services/paperless/documentReadingService.js';

// A Duttons-style invoice, as [text, x, y]
const DUTTONS = [
  ['Duttons Builders Merchants Ltd', 36, 813], ['Vat No.', 385, 674], ['GB 162 395 011', 484, 673],
  ['Document No.', 385, 649], ['260461', 524, 647], ['Date', 385, 636], ['28/09/2026', 508, 635],
  ['Part No.', 39, 559], ['Description', 137, 559], ['Price', 360, 559], ['Qty', 417, 559], ['Goods', 466, 559], ['VAT', 539, 558],
  ['MJIADB20', 36, 544], ['Ad Blue 20L', 137, 543], ['25.00', 356, 542], ['1.00', 413, 542], ['25.00', 465, 543], ['5.00', 533, 543],
  ['SAN3625', 36, 526], ['Plastering sand', 137, 526], ['4.28', 361, 525], ['3.00', 413, 525], ['12.85', 465, 526], ['2.57', 533, 525],
  ['Total Goods', 360, 208], ['37.85', 513, 208], ['Total VAT', 360, 188], ['7.57', 519, 188], ['Total Due', 360, 159], ['45.42', 513, 159],
  ['TERMS STRICTLY 30 DAYS NET.', 40, 42],
];
const pdf = () => makePdf([DUTTONS]);

const models = (seed = {}) => ({
  OcrDocument: memoryModel(seed.docs || [{ paperlessId: 1110, correspondent: { id: 7, name: 'Duttons Builders Merchants Ltd' }, processingState: 'awaiting_entry', deletedInPaperlessAt: null, added: new Date('2026-09-28') }]),
  DocumentText: memoryModel(seed.text || []),
  SupplierLayout: memoryModel(seed.layouts || []),
  Supplier: memoryModel(seed.suppliers || [{ Id: 41, Code: 'DUT01', Name: 'Duttons Builders Merchants Ltd', VatNumber: 'GB162395011' }, { Id: 42, Code: 'STA01', Name: 'Stark', VatNumber: '394 1212 63' }]),
  Purchase: memoryModel(seed.purchases || []),
});
const depsFor = (m, extra = {}) => ({ connect: null, models: () => m, fetchPdf: async () => pdf(), now: () => new Date('2026-10-06T10:00:00Z'), ...extra });

describe('reading a document on the server', () => {
  it('reads the PDF, stores its text and the reading', async () => {
    const m = models();
    const reading = await svc.readDocument(1110, depsFor(m));
    assert.equal(reading.hasText, true);
    assert.equal(reading.score, 3);
    assert.equal(reading.fields.invoiceNumber.value, '260461');
    assert.equal(reading.fields.invoiceTotal.value, '45.42');
    assert.equal(reading.fields.dueDate.value, '2026-10-28');
    assert.equal(reading.fields.dueDate.fromTerms, 'STRICTLY 30 DAYS');
    assert.equal(reading.lineCount, 2);
    assert.equal(reading.linesAddUp, true);
    assert.deepEqual(reading.vatNumbers.map((v) => v.number), ['162395011']);
    assert.equal(m.DocumentText.docs.length, 1);
    assert.equal(m.DocumentText.docs[0].items[0].length, 6);
    assert.deepEqual(m.OcrDocument.docs[0].reading.fields.invoiceNumber.value, '260461');
  });

  it('reuses stored text instead of fetching the PDF again', async () => {
    const m = models();
    await svc.readDocument(1110, depsFor(m));
    let fetched = 0;
    await svc.readDocument(1110, depsFor(m, { fetchPdf: async () => { fetched += 1; return pdf(); } }));
    assert.equal(fetched, 0);
  });

  it('a PDF with no text is marked so, and a failure is recorded, not thrown', async () => {
    const m = models();
    const blank = await svc.readDocument(1110, depsFor(m, { fetchPdf: async () => makePdf([[]]) }));
    assert.equal(blank.hasText, false);
    assert.equal(blank.score, 0);
    const m2 = models();
    const failed = await svc.readDocument(1110, depsFor(m2, { fetchPdf: async () => { throw new Error('Paperless down'); } }));
    assert.equal(failed.error, 'Paperless down');
    assert.equal(m2.OcrDocument.docs[0].reading.score, -1);
  });

  it('reads only invoices still being worked on, newest first', async () => {
    const m = models({ docs: [
      { paperlessId: 1, processingState: 'awaiting_entry', deletedInPaperlessAt: null, added: new Date('2026-09-01') },
      { paperlessId: 2, processingState: 'sent', deletedInPaperlessAt: null, added: new Date('2026-09-02') },
      { paperlessId: 3, processingState: 'entered', deletedInPaperlessAt: null, added: new Date('2026-09-03'), reading: { version: svc.READER_VERSION } },
      { paperlessId: 4, processingState: 'entered', deletedInPaperlessAt: null, added: new Date('2026-09-04'), reading: { version: 0 } },
    ] });
    const r = await svc.readMissing({ limit: 10 }, depsFor(m));
    assert.equal(r.read, 2);
    assert.ok(m.OcrDocument.docs.find((d) => d.paperlessId === 1).reading.hasText);
    assert.equal(m.OcrDocument.docs.find((d) => d.paperlessId === 2).reading, undefined);
  });
});

describe('learning from saves', () => {
  const entry = {
    invoiceNumber: '260461', invoiceDate: new Date('2026-09-28'), dueDate: null,
    totalGoods: 37.85, totalVat: 7.57, invoiceTotal: 45.4, savedAt: new Date(),
  };

  it('scores the reading against what was saved', async () => {
    const m = models();
    await svc.readDocument(1110, depsFor(m));
    m.OcrDocument.docs[0].entry = entry;
    const outcome = await svc.learnFromSave(1110, depsFor(m));
    assert.deepEqual(outcome.fields, {
      invoiceNumber: 'matched', invoiceDate: 'matched', dueDate: 'missed',
      totalGoods: 'matched', totalVat: 'matched', invoiceTotal: 'corrected',
    });
  });

  it('remembers where the supplier puts each saved value, and hands it to the next read', async () => {
    const m = models();
    await svc.readDocument(1110, depsFor(m));
    m.OcrDocument.docs[0].entry = { ...entry, invoiceTotal: 45.42 };
    await svc.learnFromSave(1110, depsFor(m));
    const layout = m.SupplierLayout.docs[0];
    assert.equal(layout.correspondentId, 7);
    assert.equal(layout.invoicesLearned, 1);
    assert.equal(Math.round(layout.spots.invoiceNumber[0].x), 524);
    await svc.learnFromSave(1110, depsFor(m));
    assert.equal(m.SupplierLayout.docs[0].spots.invoiceNumber[0].seen, 2);
    const again = await svc.readDocument(1110, depsFor(m));
    assert.equal(again.usedLayout, true);
    assert.equal(again.fields.invoiceNumber.learned, true);
  });

  it('keeps a few spots per field, most seen first', () => {
    const box = (x, y) => ({ page: 1, x, y, w: 30, h: 12 });
    let spots = svc.mergeSpots({}, { invoiceNumber: box(500, 640) });
    spots = svc.mergeSpots(spots, { invoiceNumber: box(100, 700) });
    spots = svc.mergeSpots(spots, { invoiceNumber: box(102, 701) });
    assert.deepEqual(spots.invoiceNumber.map((s) => [Math.round(s.x), s.seen]), [[102, 2], [500, 1]]);
    assert.equal(Math.round(svc.layoutFromSpots(spots).invoiceNumber.x), 102);
  });
});

describe('supplier checks', () => {
  it('matches the correspondent to a KashFlow supplier and checks the VAT number', async () => {
    const m = models();
    await svc.readDocument(1110, depsFor(m));
    const ins = await svc.insights(1110, {}, depsFor(m, { ownVat: '' }));
    assert.deepEqual(ins.supplier, { name: 'Duttons Builders Merchants Ltd', code: 'DUT01', vatNumber: '162395011' });
    assert.equal(ins.vat.status, 'match');
    assert.equal(ins.invoiceNumber, '260461');
  });

  it("says whose VAT number it is when it isn't the supplier's", async () => {
    const m = models();
    const v = await svc.vatCheck(m.Supplier, { Code: 'DUT01', VatNumber: 'GB162395011' }, ['394121263'], { ownVat: '' });
    assert.equal(v.status, 'mismatch');
    assert.deepEqual(v.belongsTo, [{ name: 'Stark', code: 'STA01' }]);
  });

  it("leaves out the company's own VAT number", async () => {
    const m = models();
    const v = await svc.vatCheck(m.Supplier, { Code: 'DUT01', VatNumber: 'GB162395011' }, ['252295994'], { ownVat: 'GB 252 2959 94' });
    assert.equal(v.status, 'none_found');
  });

  it('finds the invoice number already in KashFlow or on another document, however it is spaced', async () => {
    const m = models({
      docs: [
        { paperlessId: 1110, correspondent: { id: 7, name: 'Duttons Builders Merchants Ltd' }, deletedInPaperlessAt: null },
        { paperlessId: 1099, title: 'Heron 260461', correspondent: { id: 7 }, deletedInPaperlessAt: null, processingState: 'sent', entry: { invoiceNumber: '260461' } },
        { paperlessId: 1098, correspondent: { id: 8 }, deletedInPaperlessAt: null, entry: { invoiceNumber: '260461' } },
      ],
      purchases: [
        { Number: 5012, SupplierId: 41, SupplierCode: 'DUT01', SupplierName: 'Duttons Builders Merchants Ltd', SupplierReference: '260-461', GrossAmount: 45.42 },
        { Number: 5013, SupplierId: 99, SupplierCode: 'OTH', SupplierName: 'Other', SupplierReference: '260461' },
      ],
    });
    const ins = await svc.insights(1110, { invoiceNumber: '260461' }, depsFor(m, { ownVat: '' }));
    assert.deepEqual(ins.duplicates.kashflow.map((p) => p.number), [5012]);
    assert.deepEqual(ins.duplicates.documents.map((d) => d.paperlessId), [1099]);
  });
});

describe('accuracy and fixtures', () => {
  it('reports how often the reading was kept, by supplier and field', async () => {
    const m = models({ docs: [
      { paperlessId: 1, title: 'A', correspondent: { name: 'Duttons' }, readingOutcome: { fields: { invoiceNumber: 'matched', invoiceTotal: 'matched' } } },
      { paperlessId: 2, title: 'B', correspondent: { name: 'Duttons' }, readingOutcome: { fields: { invoiceNumber: 'corrected', invoiceTotal: 'matched' } } },
      { paperlessId: 3, title: 'C', correspondent: { name: 'Stark' }, readingOutcome: { fields: { invoiceNumber: 'filled' } } },
    ] });
    const r = await svc.accuracyReport(depsFor(m));
    assert.equal(r.documents, 3);
    assert.equal(r.overall.invoiceNumber.rate, 33);
    assert.equal(r.overall.invoiceTotal.rate, 100);
    assert.deepEqual(r.suppliers.map((s) => [s.name, s.documents, s.fields.invoiceNumber.rate]), [['Duttons', 2, 50], ['Stark', 1, 0]]);
    assert.deepEqual(r.corrected.map((c) => c.paperlessId), [3, 2]);
  });

  it('exports a saved invoice as a fixture of its text and saved values', async () => {
    const m = models();
    await svc.readDocument(1110, depsFor(m));
    m.OcrDocument.docs[0].entry = { invoiceNumber: '260461', invoiceDate: new Date('2026-09-28'), invoiceTotal: 45.42, lines: [{ description: 'Ad Blue 20L', quantity: 1, price: 25, total: 25, vatRate: 20 }] };
    const fx = await svc.fixtureFor(1110, depsFor(m));
    assert.equal(fx.expected.invoiceNumber, '260461');
    assert.equal(fx.expected.invoiceDate, '2026-09-28');
    assert.equal(fx.expected.invoiceTotal, '45.42');
    assert.equal(fx.expected.lines[0].description, 'Ad Blue 20L');
    assert.ok(fx.items.length > 20);
  });
});

describe('routes, permissions and views', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const ejs = createRequire(import.meta.url)('ejs');
  const { QUEUES } = (await import('../mongoose/services/paperless/documentQueueService.js')).default;
  const { makeGetInsights } = await import('../mongoose/controllers/documentReadingController.js');
  const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

  it('every reading route is behind the Paperless guard and admin-only', () => {
    const routes = read('mongoose/routes/paperlessRoutes.js');
    const perms = read('mongoose/config/rolePermissionsConfig.js');
    for (const [method, p, fn] of [
      ['get', '/paperless/ocr/:paperlessId/insights', 'getInsights'],
      ['post', '/paperless/ocr/:paperlessId/read', 'postRead'],
      ['post', '/paperless/ocr/:paperlessId/reprocess', 'postReprocess'],
      ['get', '/paperless/ocr/:paperlessId/reading-fixture', 'getFixture'],
      ['get', '/paperless/reading', 'getReport'],
    ]) {
      assert.ok(routes.includes(`router.${method}("${p}", ...paperlessGuard, readingCtrl.${fn})`), `${method} ${p}`);
      const line = perms.split('\n').find((l) => l.includes(`'${p}':`));
      assert.ok(line && line.includes("['admin']"), p);
    }
  });

  it('insights passes only a trimmed invoice number and clean VAT numbers to the service', async () => {
    let asked = null;
    const handler = makeGetInsights({ service: { insights: async (id, q) => { asked = { id, ...q }; return { ok: true }; } } });
    const res = { statusCode: 200, headers: {}, body: null, status(c) { this.statusCode = c; return this; }, set(h) { Object.assign(this.headers, h === 'Cache-Control' ? { 'Cache-Control': arguments[1] } : h); return this; }, json(b) { this.body = b; return this; } };
    await handler({ params: { paperlessId: '1110' }, query: { invoiceNumber: 'INV-1'.padEnd(80, 'x'), vat: 'GB 162 395 011,<script>,394121263' } }, res);
    assert.equal(asked.id, 1110);
    assert.equal(asked.invoiceNumber.length, 60);
    assert.deepEqual(asked.vatNumbers, ['GB162395011', 'script', '394121263']);
    assert.deepEqual(res.body, { ok: true });
    const res404 = { ...res, statusCode: 200, status(c) { this.statusCode = c; return this; } };
    await handler({ params: { paperlessId: 'abc' }, query: {} }, res404);
    assert.equal(res404.statusCode, 404);
  });

  it('the queue shows what was read, flags a PDF with no text, and offers "best read first"', async () => {
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/queue.ejs'), {
      key: 'needs-entry', queue: QUEUES['needs-entry'], queues: QUEUES, total: 3, page: 1, pages: 2, sort: 'read',
      counts: { 'needs-entry': 3, ready: 0, statements: 0 }, unclassified: { invoices: 0, statements: 0 }, paperlessUiBase: null,
      docs: [
        { paperlessId: 1, title: 'A', reading: { hasText: true, score: 3, fields: { invoiceNumber: { value: '260461' }, invoiceTotal: { value: '1045.42' } }, lineCount: 2, linesAddUp: true } },
        { paperlessId: 2, title: 'B', reading: { hasText: false, score: 0 } },
        { paperlessId: 3, title: 'C' },
      ],
    });
    assert.match(html, /260461/);
    assert.match(html, /£1,045\.42 · 2 lines/);
    assert.match(html, />No text</);
    assert.match(html, /Not read yet/);
    assert.match(html, /href="\?page=2&amp;sort=read"|href="\?page=2&sort=read"/);
  });

  it('the entry page never passes `layout` to its template (express-ejs-layouts reads it as the layout file)', () => {
    // 6.53.1 passed the learned supplier layout as `layout`: once a supplier had
    // one (after the first save), every entry page for it failed with
    // 'The "path" argument must be of type string. Received an instance of Object'
    const ctrl = read('mongoose/controllers/documentEntryController.js');
    assert.ok(!/^\s+layout\s*:/m.test(ctrl), 'no `layout:` local');
    assert.match(ctrl, /readerLayout: hints\?\.layout/);
  });

  it('the entry page offers to OCR a PDF with no text again', async () => {
    const view = read('mongoose/views/tailwindcss/paperless/entry.ejs');
    assert.match(view, /action="\/paperless\/ocr\/<%= doc\.paperlessId %>\/reprocess"/);
    assert.match(view, /action="\/paperless\/ocr\/<%= doc\.paperlessId %>\/read"/);
    assert.match(view, /data-layout="<%= JSON\.stringify\(locals\.readerLayout \|\| \{\}\) %>"/);
    assert.ok(view.includes('<div data-suggest-insights hidden></div>'));
  });

  it('the accuracy report renders rates and fixture links', async () => {
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/reading.ejs'), {
      fields: svc.HEADER_FIELDS,
      report: {
        documents: 2,
        overall: Object.fromEntries(svc.HEADER_FIELDS.map((f) => [f, { matched: 1, corrected: 1, filled: 0, missed: 0, none: 0, rate: 50 }])),
        suppliers: [{ name: 'Duttons', documents: 2, fields: Object.fromEntries(svc.HEADER_FIELDS.map((f) => [f, { matched: 2, corrected: 0, filled: 0, missed: 0, none: 0, rate: 100 }])) }],
        corrected: [{ paperlessId: 9, title: 'Heron 9', supplier: 'Duttons', fields: ['invoiceTotal'] }],
      },
    });
    assert.match(html, /50%/);
    assert.match(html, /100%/);
    assert.match(html, /href="\/paperless\/ocr\/9\/reading-fixture"/);
  });
});
