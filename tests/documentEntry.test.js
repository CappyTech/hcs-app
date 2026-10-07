import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';

process.env.PAPERLESS_URL = 'mock';

import entrySvc from '../mongoose/services/paperless/documentEntryService.js';
import { customFieldsWithEntry } from '../mongoose/services/paperless/entryOverlay.js';
import { buildPurchaseDraftFromOcr } from '../mongoose/services/paperless/purchaseDraftService.js';
import { makeGetFile } from '../mongoose/controllers/documentEntryController.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';
import fixtures from '../mongoose/services/paperless/mock/fixtures.js';

const require = createRequire(import.meta.url);
const ejs = require('ejs');

const {
  parseMoneyInput, parseDateInput, entryKind, parseEntryForm, completionErrors, consistencyWarnings,
  formValues, saveEntry, completeEntry, setCreditNote, reopenEntry, markReviewed,
} = entrySvc;
const { makeMockClient, resetMockPaperless, mockPaperlessState } = mockPaperless;

/** H5: entry screen and viewer (PAPERLESS-MIGRATION.md H5; PB-2, PB-4, PB-5, PB-9, PB-12). */

const PI = { id: 1, name: 'Purchase Invoice' };
const SI = { id: 3, name: 'Subcontractor Invoice' };
const STATEMENT = { id: 2, name: 'Supplier Statement' };
const BANK = { id: 4, name: 'Bank Statement' };
const REMITTANCE = { id: 5, name: 'Remittance Advice' };

const user = { userId: new mongoose.Types.ObjectId(), name: 'bev', isAdmin: false };
const admin = { userId: new mongoose.Types.ObjectId(), name: 'jack', isAdmin: true };

// In-memory OcrDocument for the calls the services make
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
          Object.assign(r, structuredClone(update.$set || {}));
          for (const [k, v] of Object.entries(update.$push || {})) r[k] = [...(r[k] || []), ...(v.$each || [v])];
          return clone(r);
        },
      };
    },
  };
}

const fullEntry = () => ({
  invoiceNumber: 'INV-1001',
  invoiceDate: new Date('2026-09-01'),
  dueDate: null,
  totalGoods: 65,
  totalVat: 13,
  invoiceTotal: 78,
  lines: [{ description: 'Cement 25kg', quantity: 10, price: 6.5, total: 65, vatRate: 20 }],
  savedAt: new Date('2026-10-03T09:00:00Z'),
});

describe('parsing helpers', () => {
  it('reads money the ways people and Paperless write it', () => {
    assert.equal(parseMoneyInput('123.45'), 123.45);
    assert.equal(parseMoneyInput('GBP123.45'), 123.45);
    assert.equal(parseMoneyInput('£1,234.50'), 1234.5);
    assert.equal(parseMoneyInput('GBP-12.00'), -12);
    assert.equal(parseMoneyInput(''), null);
    assert.equal(parseMoneyInput(7), 7);
    assert.equal(typeof parseMoneyInput('12abc'), 'symbol', 'invalid');
  });

  it('reads <input type=date> values and rejects impossible dates', () => {
    assert.deepEqual(parseDateInput('2026-09-01'), new Date(Date.UTC(2026, 8, 1)));
    assert.equal(parseDateInput(''), null);
    assert.equal(typeof parseDateInput('2026-02-30'), 'symbol');
    assert.equal(typeof parseDateInput('01/09/2026'), 'symbol');
  });

  it('picks the form by document type (PB-2)', () => {
    assert.equal(entryKind({ documentType: PI }), 'invoice');
    assert.equal(entryKind({ documentType: SI }), 'invoice');
    assert.equal(entryKind({ documentType: BANK }), 'bank');
    assert.equal(entryKind({ documentType: STATEMENT }), 'statement');
    assert.equal(entryKind({ documentType: REMITTANCE }), null, 'remittances have no fields');
    assert.equal(entryKind({}), null);
  });
});

describe('parseEntryForm (every field in section 3)', () => {
  it('takes the invoice header and lines', () => {
    const { entry, errors } = parseEntryForm({
      invoiceNumber: ' NPH-778 ', invoiceDate: '2026-09-05', dueDate: '2026-10-05',
      totalGoods: 'GBP200.00', totalVat: '40', invoiceTotal: '£240.00',
      lines: [
        { description: 'Excavator hire 1 week', quantity: '1', price: '200', total: '200', vatRate: '20' },
        { description: '', quantity: '', price: '', total: '', vatRate: '' },
      ],
    }, 'invoice');
    assert.deepEqual(errors, {});
    assert.equal(entry.invoiceNumber, 'NPH-778');
    assert.deepEqual(entry.invoiceDate, new Date(Date.UTC(2026, 8, 5)));
    assert.deepEqual(entry.dueDate, new Date(Date.UTC(2026, 9, 5)));
    assert.deepEqual([entry.totalGoods, entry.totalVat, entry.invoiceTotal], [200, 40, 240]);
    assert.deepEqual(entry.lines, [{ description: 'Excavator hire 1 week', quantity: 1, price: 200, total: 200, vatRate: 20 }], 'blank line dropped');
  });

  it('takes more than 7 lines, including past qs\'s 20-index array limit', () => {
    const lines = {};
    for (let i = 0; i < 25; i++) lines[i] = { description: `Item ${i + 1}`, total: String(i + 1) };
    const { entry } = parseEntryForm({ lines }, 'invoice');
    assert.equal(entry.lines.length, 25);
    assert.equal(entry.lines[24].description, 'Item 25');
  });

  it('works out a missing line total from quantity × price', () => {
    const { entry } = parseEntryForm({ lines: [{ description: 'Screws', quantity: '3', price: '1.335' }] }, 'invoice');
    assert.equal(entry.lines[0].price, 1.335, 'unit price keeps its decimals');
    assert.equal(entry.lines[0].total, 4.01);
  });

  it('reports bad values per field and keeps going', () => {
    const { errors } = parseEntryForm({
      invoiceDate: '31/09/2026', totalGoods: 'lots',
      lines: [{ description: 'x', quantity: 'two', vatRate: '120' }],
    }, 'invoice');
    assert.deepEqual(Object.keys(errors).sort(), ['invoiceDate', 'lines.0.quantity', 'lines.0.vatRate', 'totalGoods']);
  });

  it('refuses a VAT amount in VAT %, and says why', () => {
    const { entry, errors } = parseEntryForm({
      invoiceNumber: 'A1', lines: [
        { description: 'Cement', quantity: '1', price: '28.09', total: '28.09', vatRate: '5.62' },
        { description: 'Sand', quantity: '1', price: '10', total: '10', vatRate: '3' },
        { description: 'Bricks', quantity: '1', price: '10', total: '10', vatRate: '20%' },
      ],
    }, 'invoice');
    assert.equal(errors['lines.0.vatRate'], 'Line 1 VAT % is "5.62". VAT % is a percentage (0, 5, 20), not an amount.');
    assert.match(errors['lines.1.vatRate'], /Line 2 VAT % is "3"/);
    assert.equal(errors['lines.2.vatRate'], undefined);
    assert.equal(entry.lines[2].vatRate, 20);
    // One saved before the guard is still warned about
    assert.match(consistencyWarnings({ lines: [{ total: 10, vatRate: 3 }] })[0], /Line 1 VAT % is "3"/);
  });

  it('takes the bank statement fields (53–57)', () => {
    const { entry, errors } = parseEntryForm({ bank: {
      accountId: '12', periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: '1,000.00', closingBalance: '1250',
    } }, 'bank');
    assert.deepEqual(errors, {});
    assert.deepEqual(entry.bank, {
      accountId: 12, periodStart: new Date(Date.UTC(2026, 8, 1)), periodEnd: new Date(Date.UTC(2026, 8, 30)),
      openingBalance: 1000, closingBalance: 1250,
    });
    assert.ok(parseEntryForm({ bank: { periodStart: '2026-09-30', periodEnd: '2026-09-01' } }, 'bank').errors['bank.periodEnd']);
  });
});

describe('completion rules and totals', () => {
  it('needs number, date, total and one usable line before Complete entry', () => {
    assert.deepEqual(completionErrors(fullEntry()), {});
    assert.deepEqual(Object.keys(completionErrors({ lines: [{ description: 'x' }] })).sort(), ['invoiceDate', 'invoiceNumber', 'invoiceTotal', 'lines']);
    assert.ok(completionErrors(null).form);
  });

  it('warns when the totals do not add up', () => {
    assert.deepEqual(consistencyWarnings(fullEntry()), []);
    const bad = { ...fullEntry(), totalGoods: 60, invoiceTotal: 80, lines: [{ quantity: 10, price: 6.5, total: 64 }] };
    const w = consistencyWarnings(bad);
    assert.equal(w.length, 3);
    assert.match(w[0], /Line 1: 10 × 6\.50 is 65\.00, not 64\.00/);
    assert.match(w[1], /Line totals add up to 64\.00, but total goods is 60\.00/);
    assert.match(w[2], /not the invoice total 80\.00/);
  });

  it('allows for a per-thousand price kept to 4 places', () => {
    // 794.51 per thousand → 0.7945 a brick; 5,000 × 0.7945 = 3972.50 against 3972.55
    const bricks = (quantity, total) => consistencyWarnings({ lines: [{ quantity, price: 0.7945, total }] });
    assert.deepEqual(bricks(1, 0.79), []);
    assert.deepEqual(bricks(5000, 3972.55), []);
    assert.equal(bricks(1, 794.51).length, 1);
    assert.equal(bricks(5000, 3980).length, 1);
  });

  it('warns when VAT at the line rates is not the total VAT, allowing a penny a line', () => {
    const lines = [{ total: 22.44, vatRate: 20 }, { total: 15.74, vatRate: 20 }];
    const base = { totalGoods: 38.18, invoiceTotal: 45.82, lines };
    assert.deepEqual(consistencyWarnings({ ...base, totalVat: 7.64 }), []); // 7.636, rounded on the total
    assert.deepEqual(consistencyWarnings({ ...base, totalVat: 7.65, invoiceTotal: 45.83 }), []); // rounded per line
    const w = consistencyWarnings({ ...base, totalVat: 6.36, invoiceTotal: 44.54 });
    assert.deepEqual(w, ['VAT at the line rates comes to 7.64, but total VAT is 6.36.']);
    // A line with no rate: nothing to compare
    assert.deepEqual(consistencyWarnings({ ...base, totalVat: 6.36, invoiceTotal: 44.54, lines: [lines[0], { total: 15.74 }] }), []);
  });

  it('accepts a credit note with negative totals', () => {
    const cn = { ...fullEntry(), totalGoods: -10, totalVat: -2, invoiceTotal: -12, lines: [{ description: 'Returned goods', total: -10 }] };
    assert.deepEqual(completionErrors(cn), {});
    assert.deepEqual(consistencyWarnings(cn), []);
  });
});

describe('formValues', () => {
  const asOcr = (d) => ({
    paperlessId: d.id,
    documentType: fixtures.DOCUMENT_TYPES.find((t) => t.id === d.document_type),
    customFields: d.custom_fields.map((e) => ({ fieldId: e.field, fieldName: fixtures.CUSTOM_FIELDS.find((f) => f.id === e.field)?.name, value: e.value })),
  });

  it('fills the form from the Paperless custom fields when nothing is saved in hcs-app', () => {
    const v = formValues(asOcr(fixtures.DOCUMENTS.find((d) => d.id === 9002)));
    assert.equal(v.source, 'paperless');
    assert.equal(v.invoiceNumber, 'NPH-778');
    assert.equal(v.invoiceDate, '2026-09-05');
    assert.deepEqual([v.totalGoods, v.totalVat, v.invoiceTotal], [200, 40, 240]);
    assert.deepEqual(v.lines, [{ description: 'Excavator hire 1 week', quantity: 1, price: 200, total: 200, vatRate: 20 }]);
  });

  it('uses the hcs-app entry once one is saved', () => {
    const v = formValues({ documentType: PI, customFields: [{ fieldName: 'Invoice Number', value: 'OLD' }], entry: fullEntry() });
    assert.equal(v.source, 'hcs-app');
    assert.equal(v.invoiceNumber, 'INV-1001');
    assert.equal(v.invoiceDate, '2026-09-01');
  });
});

describe('KashFlow draft reads the hcs-app entry first (decision: Mongo only)', () => {
  const paperlessFields = [
    { fieldName: 'Invoice Number', value: 'FROM-PAPERLESS' },
    { fieldName: 'Invoice Due Date', value: '2026-10-31' },
    { fieldName: 'Description_Line1', value: 'Paperless line 1' },
    { fieldName: 'Total_Line1', value: 'GBP1.00' },
    { fieldName: 'Description_Line2', value: 'Paperless line 2' },
    { fieldName: 'Total_Line2', value: 'GBP2.00' },
  ];

  it('puts entry fields first and drops Paperless lines when the entry has its own', () => {
    const cf = customFieldsWithEntry({ customFields: paperlessFields, entry: fullEntry() });
    assert.equal(cf[0].fieldName, 'Invoice Number');
    assert.equal(cf[0].value, 'INV-1001');
    assert.ok(!cf.some((f) => f.value === 'Paperless line 2'));
    assert.ok(cf.some((f) => f.fieldName === 'Invoice Due Date' && f.value === '2026-10-31'), 'a blank entry field falls back');
  });

  it('builds the draft from the entry', () => {
    const draft = buildPurchaseDraftFromOcr({ paperlessId: 1, correspondent: { name: 'Acme' }, customFields: paperlessFields, entry: fullEntry() });
    assert.equal(draft.SupplierReference, 'INV-1001');
    assert.equal(draft.GrossAmount, 78);
    assert.equal(draft.LineItems.length, 1);
    assert.equal(draft.LineItems[0].Description, 'Cement 25kg');
  });

  it('leaves documents with no hcs-app entry exactly as before', () => {
    const ocr = { paperlessId: 1, correspondent: { name: 'Acme' }, customFields: paperlessFields };
    assert.equal(customFieldsWithEntry(ocr), paperlessFields);
    assert.equal(buildPurchaseDraftFromOcr(ocr).SupplierReference, 'FROM-PAPERLESS');
  });
});

describe('saveEntry', () => {
  it('stores the entry with who and when', async () => {
    const M = fakeOcrDocument([{ paperlessId: 1, documentType: PI, processingState: 'awaiting_entry' }]);
    const r = await saveEntry(M, 1, { invoiceNumber: 'A1' }, user, { now: new Date('2026-10-03T10:00:00Z') });
    assert.equal(r.ok, true);
    assert.equal(M.rows[0].entry.invoiceNumber, 'A1');
    assert.ok(M.rows[0].entry.savedBy.userId, 'who saved it is stored');
    assert.deepEqual(M.rows[0].entry.savedAt, new Date('2026-10-03T10:00:00Z'));
    assert.equal(M.rows[0].entry.savedBy.name, 'bev');
  });

  it('refuses once the invoice is in KashFlow, and for documents with no form', async () => {
    const M = fakeOcrDocument([
      { paperlessId: 1, documentType: PI, processingState: 'sent' },
      { paperlessId: 2, documentType: REMITTANCE },
      { paperlessId: 3, documentType: STATEMENT },
    ]);
    assert.equal((await saveEntry(M, 1, {}, user)).reason, 'locked');
    assert.equal((await saveEntry(M, 2, {}, user)).reason, 'no-form');
    assert.equal((await saveEntry(M, 3, {}, user)).reason, 'no-form');
  });
});

describe('actions against the mock Paperless', () => {
  beforeEach(() => resetMockPaperless());
  const tagsOf = (id) => mockPaperlessState().documents.find((d) => d.id === id).tags;
  const cfOf = (id, fid) => mockPaperlessState().documents.find((d) => d.id === id).custom_fields.find((e) => e.field === fid)?.value;

  it('Complete entry moves to entered, adds "data entry done" and removes "inbox", without touching other tags (PB-5)', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9001, documentType: PI, processingState: 'awaiting_entry', entry: fullEntry() }]);
    assert.ok(tagsOf(9001).includes(3), 'fixture starts in the inbox');
    const r = await completeEntry(M, 9001, user);
    assert.equal(r.ok, true);
    assert.equal(r.paperlessWarning, null);
    assert.equal(M.rows[0].processingState, 'entered');
    assert.deepEqual(tagsOf(9001).sort((a, b) => a - b), [1, 16]);
    assert.equal((await completeEntry(M, 9001, user)).reason, 'invalid-state', 'completing twice does nothing');
  });

  it('Complete entry refuses an incomplete entry', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9001, documentType: PI, processingState: 'awaiting_entry', entry: { invoiceNumber: 'X', savedAt: new Date() } }]);
    const r = await completeEntry(M, 9001, user);
    assert.equal(r.reason, 'incomplete');
    assert.ok(r.errors.invoiceDate);
    assert.equal(M.rows[0].processingState, 'awaiting_entry');
    assert.deepEqual(mockPaperlessState().calls.filter((c) => c.method !== 'GET'), []);
  });

  it('keeps the state change and warns when Paperless cannot be tagged', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9001, documentType: PI, processingState: 'awaiting_entry', entry: fullEntry() }]);
    const r = await completeEntry(M, 9001, user, { modifyTags: async () => { throw new Error('down'); } });
    assert.equal(r.ok, true);
    assert.equal(M.rows[0].processingState, 'entered');
    assert.match(r.paperlessWarning, /Add the "data entry done" tag in Paperless so the invoice email is sent, and remove "inbox"/);
  });

  it('Credit note sets manual_kashflow and Credit Note in Paperless; only an admin can undo it (PB-9, PB-12)', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9003, documentType: PI, processingState: 'awaiting_entry' }]);
    const on = await setCreditNote(M, 9003, true, user);
    assert.equal(on.ok, true);
    assert.equal(M.rows[0].processingState, 'manual_kashflow');
    assert.equal(M.rows[0].creditNote, true);
    assert.equal(cfOf(9003, 58), 'true');
    assert.deepEqual(tagsOf(9003), [16], 'flagging takes it out of the Paperless inbox');
    const calls = mockPaperlessState().calls.filter((c) => c.method === 'POST').map((c) => c.body?.method);
    assert.deepEqual(calls, ['modify_tags', 'modify_custom_fields'], 'untag before setting Credit Note, so WF5 checks a true field once');

    assert.equal((await setCreditNote(M, 9003, false, user)).reason, 'forbidden');
    const off = await setCreditNote(M, 9003, false, admin);
    assert.equal(off.ok, true);
    assert.equal(M.rows[0].processingState, 'awaiting_entry');
    assert.equal(cfOf(9003, 58), 'false');
    assert.deepEqual(tagsOf(9003).sort((a, b) => a - b), [3, 16], 'unflagging puts it back in the Paperless inbox');
    const after = mockPaperlessState().calls.filter((c) => c.method === 'POST').map((c) => c.body?.method).slice(2);
    assert.deepEqual(after, ['modify_custom_fields', 'modify_tags'], 'untick Credit Note before re-tagging');
  });

  it('Mark reviewed takes a statement out of the Paperless inbox the first time only (PB-10)', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9005, documentType: STATEMENT, statementReviewed: false }]);
    const r = await markReviewed(M, 9005, user);
    assert.equal(r.ok, true);
    assert.equal(r.firstTime, true);
    assert.equal(r.paperlessWarning, null);
    assert.deepEqual(tagsOf(9005), [5]);
    const before = mockPaperlessState().calls.length;
    assert.equal((await markReviewed(M, 9005, user)).firstTime, false);
    assert.equal(mockPaperlessState().calls.length, before, 'reviewing again leaves Paperless alone');
  });

  it('warns when the statement cannot be untagged', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9005, documentType: STATEMENT, statementReviewed: false }]);
    const r = await markReviewed(M, 9005, user, { modifyTags: async () => { throw new Error('down'); }, notify: async () => null });
    assert.equal(r.ok, true);
    assert.match(r.paperlessWarning, /Remove the "inbox" tag in Paperless so the statement email is sent/);
  });

  it('will not flag an invoice already in KashFlow', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9003, documentType: PI, processingState: 'sent' }]);
    assert.equal((await setCreditNote(M, 9003, true, user)).reason, 'invalid-state');
  });

  it('Reopen (admin) sends it back, removes "data entry done" and adds "inbox" back', async () => {
    const M = fakeOcrDocument([{ paperlessId: 9002, documentType: PI, processingState: 'entered' }]);
    assert.equal((await reopenEntry(M, 9002, user)).reason, 'forbidden');
    const r = await reopenEntry(M, 9002, admin);
    assert.equal(r.ok, true);
    assert.equal(M.rows[0].processingState, 'awaiting_entry');
    assert.ok(!tagsOf(9002).includes(1));
    assert.ok(tagsOf(9002).includes(3), 'back in the Paperless inbox');
    assert.ok(tagsOf(9002).includes(19), 'notified/john kept, so John is not emailed twice');
  });
});

describe('PDF file proxy and fixture PDFs', () => {
  beforeEach(() => resetMockPaperless());

  class FakeRes extends Writable {
    constructor() { super(); this.chunks = []; this.headers = {}; this.statusCode = 200; }
    _write(chunk, _enc, cb) { this.chunks.push(chunk); cb(); }
    status(c) { this.statusCode = c; return this; }
    set(h, v) { if (typeof h === 'object') Object.assign(this.headers, h); else this.headers[h] = v; return this; }
    type(t) { this.headers['Content-Type'] = t; return this; }
    send(b) { this.chunks.push(Buffer.from(String(b))); this.end(); return this; }
    get body() { return Buffer.concat(this.chunks); }
  }

  it('streams the PDF from Paperless with safe headers', async () => {
    const res = new FakeRes();
    await makeGetFile({ makeClient: makeMockClient })({ params: { paperlessId: '9001' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/pdf');
    assert.match(res.headers['Content-Disposition'], /^inline; filename="document-9001\.pdf"$/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
    assert.ok(mockPaperlessState().calls.some((c) => c.path === '/documents/9001/preview/'));
  });

  it('404s for a document Paperless does not have, and 502s when Paperless fails', async () => {
    let res = new FakeRes();
    await makeGetFile({ makeClient: makeMockClient })({ params: { paperlessId: '424242' } }, res);
    assert.equal(res.statusCode, 404);
    mockPaperlessState().failNext.add('getDocumentFile');
    res = new FakeRes();
    await makeGetFile({ makeClient: makeMockClient })({ params: { paperlessId: '9001' } }, res);
    assert.equal(res.statusCode, 502);
    res = new FakeRes();
    await makeGetFile({ makeClient: makeMockClient })({ params: { paperlessId: 'abc' } }, res);
    assert.equal(res.statusCode, 404);
  });

  it('text can be copied out of every fixture PDF (PDF.js text layer source)', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const client = makeMockClient();
    for (const d of fixtures.DOCUMENTS) {
      const { stream } = await client.getDocumentFile(d.id);
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      const task = pdfjs.getDocument({ data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false, disableFontFace: true, standardFontDataUrl: `${path.resolve('node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/` });
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const text = (await page.getTextContent()).items.map((i) => i.str).join('\n');
      const firstLine = d.content.split('\n')[1];
      assert.ok(text.includes(firstLine), `#${d.id}: "${firstLine}" not found in the text layer`);
      await task.destroy();
    }
  });
});

describe('entry view', () => {
  const view = path.resolve('mongoose/views/tailwindcss/paperless/entry.ejs');
  const base = {
    title: 'INV-1001.pdf', csrfToken: 'tok', errors: {}, warnings: [], isAdmin: false, locked: false, paperlessUiBase: 'https://docs.example.test', lineCount: 2,
  };
  const render = (doc, locals = {}) => ejs.renderFile(view, {
    ...base, doc, kind: entryKind(doc), values: formValues(doc), ...locals,
  });

  it('renders the viewer, OCR text and every invoice field', async () => {
    const doc = { paperlessId: 9001, title: 'INV-1001.pdf', documentType: PI, processingState: 'awaiting_entry', ocrText: 'Cement 25kg x 10', customFields: [] };
    const html = await render(doc);
    assert.match(html, /id="pdf-viewer" data-src="\/paperless\/ocr\/9001\/file"/);
    assert.match(html, /<script type="module" src="\/resources\/js\/document-viewer\.js"><\/script>/);
    assert.match(html, /Cement 25kg x 10/);
    for (const name of ['invoiceNumber', 'invoiceDate', 'dueDate', 'totalGoods', 'totalVat', 'invoiceTotal',
      'lines[0][description]', 'lines[0][quantity]', 'lines[0][price]', 'lines[0][total]', 'lines[0][vatRate]', 'lines[1][description]']) {
      assert.ok(html.includes(`name="${name}"`), `missing ${name}`);
    }
    assert.match(html, /value="complete"/);
    assert.match(html, /Mark as credit note/);
    assert.match(html, /name="_csrf"/);
  });

  it('locks the form for an invoice already in KashFlow', async () => {
    const doc = { paperlessId: 1, documentType: PI, processingState: 'sent', customFields: [] };
    const html = await render(doc, { locked: true });
    assert.match(html, /This invoice is in KashFlow/);
    assert.ok(!html.includes('value="save"'));
    assert.match(html, /name="invoiceNumber"[^>]*disabled/);
  });

  it('makes an invoice tagged not-for-entry in Paperless read-only, with no KashFlow draft', async () => {
    const doc = { paperlessId: 1, documentType: PI, processingState: 'entered', excludedReason: 'manually_added', customFields: [] };
    const html = await render(doc, { locked: true, excluded: 'This was keyed into KashFlow by hand.' });
    assert.match(html, /Kept out of the queues\. This was keyed into KashFlow by hand\. Remove the tag in Paperless/);
    assert.ok(!html.includes('This invoice is in KashFlow'));
    assert.ok(!html.includes('value="save"'));
    assert.ok(!html.includes('/paperless/ocr/1/draft'));
  });

  it('shows admin-only actions only to admins', async () => {
    const doc = { paperlessId: 1, documentType: PI, processingState: 'entered', customFields: [] };
    assert.ok(!(await render(doc)).includes('Reopen entry'));
    assert.match(await render(doc, { isAdmin: true }), /Reopen entry \(admin\)/);
    const cn = { paperlessId: 2, documentType: PI, processingState: 'manual_kashflow', creditNote: true, customFields: [] };
    assert.match(await render(cn, { isAdmin: true }), /Not a credit note \(admin\)/);
    assert.ok(!(await render(cn)).includes('Not a credit note'));
  });

  it('gives a bank statement its five fields, and a remittance none', async () => {
    const bank = await render({ paperlessId: 3, documentType: BANK, customFields: [] });
    for (const f of ['accountId', 'periodStart', 'periodEnd', 'openingBalance', 'closingBalance']) assert.ok(bank.includes(`name="bank[${f}]"`), f);
    const rem = await render({ paperlessId: 4, documentType: REMITTANCE, customFields: [] });
    assert.match(rem, /has no fields to enter/);
    assert.ok(!rem.includes('name="action"'));
  });

  it('escapes OCR text and has no inline script', async () => {
    const html = await render({ paperlessId: 5, documentType: PI, processingState: 'awaiting_entry', ocrText: '<script>alert(1)</script>', customFields: [] });
    assert.ok(!html.includes('<script>alert(1)'));
    const src = fs.readFileSync(view, 'utf8');
    const tags = src.match(/<script[^>]*>/g) || [];
    assert.deepEqual(tags, [
      '<script type="module" src="/resources/js/document-suggestions.js">',
      '<script type="module" src="/resources/js/document-viewer.js">',
    ], 'only the module src tags');
    assert.ok(!/<script[^>]*>[^<]/.test(src), 'no inline script body');
  });
});

describe('wording', () => {
  it('names recipients by role, not by person, in the hcs-app screens', () => {
    for (const f of ['mongoose/views/tailwindcss/paperless/entry.ejs', 'mongoose/views/tailwindcss/paperless/shadowReport.ejs']) {
      const src = fs.readFileSync(path.resolve(f), 'utf8');
      assert.ok(!/\b(John|Bev)\b/.test(src), `${f} mentions a person`);
    }
  });
});

describe('H5 wiring', () => {
  const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
  it('routes are behind the Paperless guard and in the RBAC table', () => {
    const routes = read('mongoose/routes/paperlessRoutes.js');
    for (const [method, p, fn] of [
      ['get', 'entry', 'getEntry'], ['post', 'entry', 'postEntry'], ['post', 'credit-note', 'postCreditNote'],
      ['post', 'reopen', 'postReopen'], ['get', 'file', 'getFile'],
    ]) {
      assert.ok(routes.includes(`router.${method}("/paperless/ocr/:paperlessId/${p}", ...paperlessGuard, entryCtrl.${fn})`), `${method} ${p}`);
      assert.match(read('mongoose/config/rolePermissionsConfig.js'), new RegExp(`'/paperless/ocr/:paperlessId/${p}':\\s+\\['admin'\\]`));
    }
  });

  it('PDF.js is served from our own vendor assets, not a CDN', () => {
    const vendor = read('scripts/vendor-assets.js');
    for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'pdf_viewer.css', 'pdf_viewer.mjs']) assert.ok(vendor.includes(`pdfjs/${f}`), f);
    const viewer = read('public/js/document-viewer.js');
    assert.match(viewer, /from '\/resources\/vendor\/pdfjs\/pdf\.min\.mjs'/);
    assert.match(viewer, /isEvalSupported: false/);
  });

  it('text layer uses TextLayerBuilder, imported after pdf.min.mjs', () => {
    const viewer = read('public/js/document-viewer.js');
    const lib = viewer.indexOf("from '/resources/vendor/pdfjs/pdf.min.mjs'");
    const builder = viewer.indexOf("import { TextLayerBuilder } from '/resources/vendor/pdfjs/pdf_viewer.mjs'");
    assert.ok(lib >= 0 && builder > lib, 'pdf_viewer.mjs needs globalThis.pdfjsLib set first');
    assert.match(viewer, /new TextLayerBuilder\(/);
  });

  it('the Docker CSS build sees every Tailwind content path', () => {
    // A path missing from the builder stage gets its classes purged in production
    // only; .hcs-pdf-page went missing that way and broke PDF text selection.
    const dockerfile = read('Dockerfile');
    const builder = dockerfile.slice(0, dockerfile.indexOf('npm run build:css'));
    const content = read('tailwind.config.js').match(/content:\s*\[([^\]]*)\]/)[1];
    for (const [, glob] of content.matchAll(/'\.\/([^'*]+?)\/?\*/g)) {
      const dir = glob.replace(/\/$/, '');
      const covered = [...builder.matchAll(/^COPY\s+(\S+)/gm)].some(([, src]) => dir === src || dir.startsWith(`${src}/`));
      assert.ok(covered, `Dockerfile builder stage must COPY ${dir}`);
    }
  });
});
