import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memoryModel } from './helpers/memoryModel.js';
import svc from '../mongoose/services/paperless/statementReadingService.js';
import { packItem, extractItems } from '../mongoose/services/paperless/documentReadingService.js';
import { buildFixturePdf } from '../mongoose/services/paperless/mock/fixturePdf.js';

/**
 * Reading supplier statements by position (the PDF's text layer) rather than
 * the flattened OCR text, and a supplier's taught layout. Every supplier,
 * reference and amount here is made up.
 */

const SIZE = 9;
const CHAR = SIZE * 0.5;
// A text item as PDF.js gives it; `right` places it right-aligned at x
const item = (str, x, y, { page = 1, right = false } = {}) => {
  const w = str.length * CHAR;
  return { str, x: right ? x - w : x, y, w, h: SIZE, page };
};
// A row: [text, x] or [text, x, 'r'] cells on one baseline
const row = (y, cells, page = 1) => cells.map(([str, x, align]) => item(str, x, y, { page, right: align === 'r' }));

const purchase = (n, ref, date, gross, extra = {}) => ({
  uuid: `u${n}`, Number: n, SupplierReference: ref, IssuedDate: new Date(`${date}T00:00:00Z`), GrossAmount: gross, TotalPaidAmount: 0, Status: 'Unpaid', PaymentLines: [], ...extra,
});

// Date | Branch | Document Reference | Details | Value | Outstanding: an open-item statement
// whose details hold a quantity and a dotted date, and whose branch sits before the number
const OPEN_ITEM = [
  ...row(780, [['Example Fixings Ltd', 50]]),
  ...row(760, [['Statement Date 31/10/2026', 50]]),
  ...row(700, [['Date', 50], ['Branch', 110], ['Document Reference', 160], ['Details', 280], ['Value', 430], ['Outstanding', 490]]),
  ...row(685, [['02/10/2026', 50], ['0101', 110], ['SI-4401', 160], ['Qty 3.00 del 03.10.26', 280], ['120.00', 455, 'r'], ['120.00', 540, 'r']]),
  ...row(670, [['09/10/2026', 50], ['0101', 110], ['SI-4418', 160], ['Bolts', 280], ['45.50', 455, 'r'], ['20.00', 540, 'r']]),
  ...row(655, [['15/10/2026', 50], ['0101', 110], ['CN-0092', 160], ['Credit note', 280], ['-10.00', 455, 'r'], ['-10.00', 540, 'r']]),
  ...row(600, [['Total Outstanding', 400], ['130.00', 540, 'r']]),
];

// Date | Reference | Details | Debit | Credit | Balance: a running balance over two pages
const RUNNING = [
  ...row(760, [['Statement Date 30/09/2026', 50]]),
  ...row(700, [['Date', 50], ['Reference', 120], ['Details', 220], ['Debit', 380], ['Credit', 440], ['Balance', 500]]),
  ...row(685, [['02/09/2026', 50], ['A-1001', 120], ['Goods', 220], ['50.00', 405, 'r'], ['50.00', 535, 'r']]),
  ...row(670, [['04/09/2026', 50], ['BACS Payment', 220], ['50.00', 470, 'r'], ['0.00', 535, 'r']]),
  ...row(700, [['Date', 50], ['Reference', 120], ['Details', 220], ['Debit', 380], ['Credit', 440], ['Balance', 500]], 2),
  ...row(685, [['12/09/2026', 50], ['A-1009', 120], ['Goods', 220], ['75.25', 405, 'r'], ['75.25', 535, 'r']], 2),
  ...row(640, [['Closing balance', 380], ['75.25', 535, 'r']], 2),
];

const flatten = (items) => {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)) {
    const r = rows.find((x) => x.page === it.page && x.y === it.y);
    if (r) r.parts.push(it.str); else rows.push({ page: it.page, y: it.y, parts: [it.str] });
  }
  return rows.map((r) => r.parts.join(' ')).join('\n');
};

describe('reading a statement by column', () => {
  it('finds the heading row and what each column holds', () => {
    const items = OPEN_ITEM.filter((i) => i.y === 700);
    const cols = svc.headingColumns({ page: 1, y: 700, h: SIZE, items });
    assert.deepEqual(cols.map((c) => [c.label, c.role]), [
      ['Date', 'date'], ['Branch', 'code'], ['Document Reference', 'doc'], ['Details', 'details'], ['Value', 'amount'], ['Outstanding', 'outstanding'],
    ]);
    assert.equal(svc.headingColumns({ page: 1, y: 685, h: SIZE, items: OPEN_ITEM.filter((i) => i.y === 685) }), null, 'a row of figures is not a heading');
    assert.equal(svc.headingColumns({ page: 1, y: 1, h: SIZE, items: row(1, [['Account', 50], ['Date', 150], ['Page', 250]]) }), null, 'a header box with no amount column is not one');
  });

  it('splits headings printed close together when each word is a heading', () => {
    const tight = row(1, [['Date Reference', 50], ['Amount', 200]]);
    const cols = svc.headingColumns({ page: 1, y: 1, h: SIZE, items: tight });
    assert.deepEqual(cols.map((c) => c.role), ['date', 'doc', 'amount']);
  });

  it('splits headings PDF.js joined into one text item', () => {
    const joined = [item('Date', 50, 1), item('Branch Document Reference Details', 110, 1), item('Value Outstanding', 360, 1)];
    const cols = svc.headingColumns({ page: 1, y: 1, h: SIZE, items: joined });
    assert.deepEqual(cols.map((c) => c.role), ['date', 'code', 'doc', 'details', 'amount', 'outstanding']);
    assert.deepEqual(svc.headingColumns({ page: 1, y: 1, h: SIZE, items: [item('Date', 50, 1), item('Outstanding Amount', 300, 1)] }).map((c) => c.label), ['Date', 'Outstanding Amount']);
  });

  it('reads a real PDF text layer end to end', async () => {
    const text = [
      'Example Fixings Ltd', 'Statement Date 31/10/2026', '',
      'Date        Branch  Document Reference  Details                Value  Outstanding',
      '02/10/2026  0101    SI-4401             Qty 3.00 del 03.10.26  120.00       120.00',
      '09/10/2026  0101    SI-4418             Bolts                   45.50        20.00',
    ].join('\n');
    const { items } = await extractItems(buildFixturePdf(text));
    const parsed = svc.parseStatementDocument({ text, items });
    assert.equal(parsed.source, 'positions');
    assert.deepEqual(parsed.lines.map((l) => [l.prefix, l.ref, l.amount, l.balance]), [['0101', 'SI-4401', 120, 120], ['0101', 'SI-4418', 45.5, 20]]);
    assert.equal(parsed.header.openItems, true);
  });

  it('assigns each word to its column, so branch, details and amounts cannot bleed into each other', () => {
    const parsed = svc.parseStatementItems(OPEN_ITEM);
    assert.equal(parsed.source, 'positions');
    assert.equal(parsed.lines.length, 3);
    const [first, second, credit] = parsed.lines;
    assert.equal(first.ref, 'SI-4401');
    assert.equal(first.prefix, '0101', 'the branch column is the prefix');
    assert.equal(first.amount, 120, 'the Value column, not the quantity or the dotted date in the details');
    assert.equal(first.balance, 120);
    assert.equal(first.date, '2026-10-02');
    assert.equal(second.amount, 45.5);
    assert.equal(second.balance, 20, 'the Outstanding column');
    assert.equal(credit.kind, 'credit');
    assert.equal(credit.amount, -10);
    assert.equal(parsed.header.openItems, true, 'an Outstanding column and no Balance column');
    assert.equal(parsed.header.statementDate, '2026-10-31');
    assert.ok(first.box && first.box.page === 1 && first.box.w > 0, 'each line keeps where it is on the page');
    assert.deepEqual(parsed.columns.map((c) => c.role), ['date', 'code', 'doc', 'details', 'amount', 'outstanding']);

    // The flattened text has the quantity first, which the text reader takes as the amount
    const byText = svc.parseStatement(flatten(OPEN_ITEM));
    assert.equal(byText.lines[0].amount, 3);
  });

  it('reads debit and credit columns, payments in the details, and headings repeated on the next page', () => {
    const parsed = svc.parseStatementItems(RUNNING);
    assert.equal(parsed.lines.length, 3);
    assert.deepEqual(parsed.lines.map((l) => [l.kind, l.ref, l.amount, l.balance]), [
      ['invoice', 'A-1001', 50, 50],
      ['payment', null, -50, 0],
      ['invoice', 'A-1009', 75.25, 75.25],
    ]);
    assert.equal(parsed.lines[2].box.page, 2);
    assert.equal(parsed.header.openItems, undefined, 'a Balance column: a running balance');
    assert.equal(parsed.header.closingBalance, 75.25);
    assert.equal(parsed.header.periodStart, '2026-09-02');
    const rec = svc.reconcile(parsed, [purchase(1, 'A-1001', '2026-09-02', 50), purchase(2, 'A-1009', '2026-09-12', 75.25)]);
    assert.equal(rec.summary.matched, 2);
    assert.equal(rec.summary.onStatementOnly, 0);
  });

  it('with no heading row and nothing taught, leaves it to the text reader, with each line boxed where it can be', () => {
    const noHeading = OPEN_ITEM.filter((i) => i.y !== 700);
    assert.equal(svc.parseStatementItems(noHeading), null);
    const text = flatten(noHeading);
    const parsed = svc.parseStatementDocument({ text, items: noHeading });
    assert.equal(parsed.source, 'text');
    assert.ok(parsed.lines.length >= 2);
    assert.ok(parsed.lines.every((l) => l.box?.page === 1), 'boxed from the matching PDF row');
    const scanned = svc.parseStatementDocument({ text, items: [] });
    assert.equal(scanned.source, 'text');
    assert.equal(scanned.lines[0].box, undefined, 'no text layer: no boxes');
  });
});

describe('a supplier\'s taught statement layout', () => {
  // Date | Transaction | Invoice No | Amount | Balance: the guess takes Transaction as the
  // document column, but this supplier's invoice number is under Invoice No
  const MISREAD = [
    ...row(700, [['Date', 50], ['Transaction', 110], ['Invoice No', 220], ['Amount', 380], ['Balance', 480]]),
    ...row(685, [['02/09/2026', 50], ['TX88120', 110], ['INV-2001', 220], ['60.00', 410, 'r'], ['60.00', 520, 'r']]),
    ...row(670, [['05/09/2026', 50], ['TX88131', 110], ['INV-2002', 220], ['15.00', 410, 'r'], ['75.00', 520, 'r']]),
  ];
  const purchases = [purchase(1, 'INV-2001', '2026-09-02', 60), purchase(2, 'INV-2002', '2026-09-05', 15)];

  it('the guess alone reads the wrong reference column', () => {
    const parsed = svc.parseStatementItems(MISREAD);
    assert.equal(parsed.lines[0].ref, 'TX88120');
  });

  it('a taught reference column, amount and kind override the guess', () => {
    const heading = MISREAD.find((i) => i.str === 'Invoice No');
    const value = MISREAD.find((i) => i.str === '60.00' && i.x < 400); // a value, not the heading
    const taught = {
      columns: { ref: { x: heading.x, w: heading.w, label: 'Invoice No' }, amount: { x: value.x, w: value.w } },
      openItems: true,
    };
    const parsed = svc.parseStatementItems(MISREAD, { taught });
    assert.deepEqual(parsed.lines.map((l) => l.ref), ['INV-2001', 'INV-2002']);
    assert.deepEqual(parsed.lines.map((l) => l.amount), [60, 15]);
    assert.equal(parsed.header.openItems, true, 'taught open items wins over the Balance heading');
    const ref = parsed.columns.find((c) => c.role === 'doc');
    assert.equal(ref.label, 'Invoice No');
    assert.equal(ref.taught, true);
    assert.equal(svc.reconcile(parsed, purchases).summary.matched, 2);
    assert.equal(svc.parseStatementItems(MISREAD, { taught: { columns: {}, openItems: false } }).header.openItems, undefined);
  });

  it('reads by the taught columns alone when the statement prints no headings it can use', () => {
    const bare = MISREAD.filter((i) => i.y !== 700);
    assert.equal(svc.parseStatementItems(bare), null);
    const ref = MISREAD.find((i) => i.str === 'INV-2001');
    const amount = MISREAD.find((i) => i.str === '60.00' && i.x < 400);
    const parsed = svc.parseStatementItems(bare, { taught: { columns: { ref: { x: ref.x, w: ref.w }, amount: { x: amount.x, w: amount.w } } } });
    assert.deepEqual(parsed.lines.map((l) => [l.ref, l.amount, l.date]), [['INV-2001', 60, '2026-09-02'], ['INV-2002', 15, '2026-09-05']]);
  });

  it('changeLayout keeps one span per column and checks what it is given', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    let r = svc.changeLayout(null, { role: 'ref', box: { page: 1, x: 220, y: 700, w: 45, h: 9 }, label: '  Invoice   No ' }, now);
    assert.equal(r.ok, true);
    assert.deepEqual(r.statement.columns.ref, { x: 220, w: 45, page: 1, y: 700, h: 9, label: 'Invoice No', at: now });
    r = svc.changeLayout(r.statement, { openItems: false }, now);
    assert.equal(r.statement.openItems, false);
    assert.ok(r.statement.columns.ref, 'the kind leaves the columns alone');
    assert.equal(svc.changeLayout(r.statement, { role: 'vat', box: { x: 1, w: 1 } }).ok, false);
    assert.equal(svc.changeLayout(r.statement, { role: 'amount', box: { x: 'a', w: 1 } }).ok, false);
    assert.equal(svc.changeLayout(r.statement, { openItems: 'maybe' }).ok, false);
    assert.deepEqual(svc.changeLayout(r.statement, { forget: true }, now).statement, { columns: {}, openItems: null, updatedAt: now });
  });
});

describe('reading a statement document from its PDF text', () => {
  const STATEMENT = { id: 2, name: 'Supplier Statement' };
  const ocrText = flatten(OPEN_ITEM);
  const models = (extra = {}) => ({
    OcrDocument: memoryModel([
      { paperlessId: 9100, correspondent: { id: 41, name: 'Example Fixings Ltd' }, documentType: STATEMENT, ocrText, statementReviewed: false, deletedInPaperlessAt: null },
      { paperlessId: 9101, correspondent: { id: null, name: 'Example Fixings Ltd' }, documentType: STATEMENT, ocrText, statementReviewed: false, deletedInPaperlessAt: null },
      { paperlessId: 9102, correspondent: { id: 41, name: 'Example Fixings Ltd' }, documentType: { id: 1, name: 'Purchase Invoice' }, ocrText: '', deletedInPaperlessAt: null },
    ]),
    DocumentText: memoryModel(extra.text ?? [{ paperlessId: 9100, items: OPEN_ITEM.map(packItem), pages: 1, pageWidth: 595 }]),
    SupplierLayout: memoryModel(extra.layouts || []),
    Supplier: memoryModel([{ Id: 7, Code: 'EXF01', Name: 'Example Fixings Ltd' }]),
    Purchase: memoryModel([
      { ...purchase(1, 'SI-4401', '2026-10-02', 120), SupplierId: 7 },
      { ...purchase(2, 'SI-4418', '2026-10-09', 45.5, { TotalPaidAmount: 25.5 }), SupplierId: 7 },
    ]),
  });
  const deps = (m, more = {}) => ({ connect: null, models: () => m, now: () => new Date('2026-11-12T10:00:00Z'), fetchPdf: null, ...more });

  it('reads by position from the stored PDF text and keeps each line\'s box and the columns', async () => {
    const m = models();
    const st = await svc.readStatement(9100, deps(m));
    assert.equal(st.source, 'positions');
    assert.equal(st.lines[0].amount, 120);
    assert.ok(st.lines.every((l) => l.box));
    assert.ok(st.columns.some((c) => c.role === 'doc' && c.label === 'Document Reference'));
    assert.equal(st.taught, false);
    assert.equal(st.reconciliation.summary.matched, 2);
  });

  it('fetches and stores the PDF text the first time, and falls back to the OCR text when it can\'t', async () => {
    const m = models({ text: [] });
    let fetched = 0;
    const st = await svc.readStatement(9100, deps(m, { fetchPdf: async () => { fetched += 1; return Buffer.from('pdf'); }, extract: async () => ({ items: OPEN_ITEM, pages: 1, pageWidth: 595 }) }));
    assert.equal(fetched, 1);
    assert.equal(st.source, 'positions');
    assert.equal(m.DocumentText.docs.length, 1, 'stored for next time');
    const failing = models({ text: [] });
    const fallback = await svc.readStatement(9100, deps(failing, { fetchPdf: async () => { throw new Error('offline'); } }));
    assert.equal(fallback.source, 'text');
    assert.ok(fallback.lineCount > 0);
  });

  it('teachLayout saves the columns for the correspondent and reads the statement again with them', async () => {
    const m = models();
    const valueHeading = OPEN_ITEM.find((i) => i.str === 'Outstanding');
    const r = await svc.teachLayout(9100, { role: 'amount', box: { page: 1, x: valueHeading.x, y: 700, w: valueHeading.w, h: 9 }, label: 'Outstanding' }, deps(m));
    assert.equal(r.ok, true);
    assert.equal(m.SupplierLayout.docs[0].correspondentId, 41);
    assert.ok(m.SupplierLayout.docs[0].statement.columns.amount);
    assert.equal(r.reading.taught, true);
    assert.deepEqual(r.reading.lines.map((l) => l.amount), [120, 20, -10], 'the amount now comes from the column pointed out');
    assert.equal(m.OcrDocument.docs[0].statement.taught, true);

    const forgot = await svc.teachLayout(9100, { forget: true }, deps(m));
    assert.equal(forgot.reading.taught, false);
    assert.deepEqual(forgot.reading.lines.map((l) => l.amount), [120, 45.5, -10]);
  });

  it('teachLayout refuses what it can\'t remember', async () => {
    const m = models();
    assert.equal((await svc.teachLayout(9101, { openItems: true }, deps(m))).ok, false, 'no correspondent');
    assert.equal((await svc.teachLayout(9102, { openItems: true }, deps(m))).ok, false, 'not a statement');
    assert.equal((await svc.teachLayout(9100, { role: 'ref', box: null }, deps(m))).ok, false);
    assert.equal(m.SupplierLayout.docs.length, 0);
  });
});

describe('the entry screen', () => {
  it('hands each read line and its outcome to the PDF, and offers to point out the columns', async () => {
    const { createRequire } = await import('node:module');
    const path = await import('node:path');
    const ejs = createRequire(import.meta.url)('ejs');
    const { entryKind, formValues } = await import('../mongoose/services/paperless/documentEntryService.js');
    const parsed = svc.parseStatementItems(OPEN_ITEM);
    const reconciliation = svc.reconcile(parsed, [purchase(1, 'SI-4401', '2026-10-02', 120), purchase(2, 'SI-4418', '2026-10-09', 40)]);
    const doc = {
      paperlessId: 9100, title: 'Statement.pdf', documentType: { id: 2, name: 'Supplier Statement' }, correspondent: { id: 41, name: 'Example Fixings Ltd' }, ocrText: '', customFields: [],
      statementReviewed: false, classifiedAt: new Date(),
      statement: { version: svc.STATEMENT_READER_VERSION, at: new Date(), hasText: true, source: 'positions', columns: parsed.columns, taught: true, openItemsTaught: true, supplier: { id: 7, code: 'EXF01', name: 'Example Fixings Ltd' }, header: parsed.header, lines: parsed.lines, lineCount: 3, unread: 0, purchaseCount: 2, reconciliation, summaryText: svc.summaryText({ hasText: true, supplier: {}, reconciliation }) },
    };
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/entry.ejs'), {
      title: 'Statement.pdf', csrfToken: 'tok', errors: {}, warnings: [], isAdmin: false, locked: false, paperlessUiBase: '', lineCount: 1,
      doc, kind: entryKind(doc), values: formValues(doc),
    });
    const attr = html.match(/data-statement-marks="([^"]*)"/)[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const marks = JSON.parse(attr);
    assert.deepEqual(marks.map((m) => [m.key, m.tone]), [['line:0', 'ok'], ['line:1', 'differs'], ['line:2', 'missing']]);
    assert.ok(marks.every((m) => m.box.page === 1));
    assert.match(html, /data-statement-line="2"/);
    assert.match(html, /read column by column from the PDF, as pointed out for this supplier/);
    assert.match(html, /“Document Reference”/);
    assert.match(html, /data-teach-role="ref"/);
    assert.match(html, /data-teach-kind="open" aria-pressed="true"/);
    assert.match(html, /data-teach-forget/);
    assert.match(html, /statement-marks\.js/);

    const byText = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/entry.ejs'), {
      title: 'Statement.pdf', csrfToken: 'tok', errors: {}, warnings: [], isAdmin: false, locked: false, paperlessUiBase: '', lineCount: 1,
      doc: { ...doc, correspondent: { id: null, name: 'Example Fixings Ltd' }, statement: { ...doc.statement, source: 'text', columns: [], taught: false } }, kind: entryKind(doc), values: formValues(doc),
    });
    assert.match(byText, /read from the OCR text/);
    assert.match(byText, /no correspondent in Paperless/);
    assert.doesNotMatch(byText, /data-teach-role/);
  });
});
