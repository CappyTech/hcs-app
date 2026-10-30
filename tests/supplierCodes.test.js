import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.PAPERLESS_URL = 'mock';

import { correspondentLabel, parseCorrespondentName } from '../mongoose/services/paperless/correspondentName.js';
import syncSvc from '../mongoose/services/paperless/supplierCorrespondentSyncService.js';
import { assignSupplier, supplierOptions } from '../mongoose/services/paperless/documentSupplierService.js';
import { supplierFor, supplierMatch } from '../mongoose/services/paperless/documentReadingService.js';
import entrySvc from '../mongoose/services/paperless/documentEntryService.js';
import { findLines, findDayLines } from '../public/js/invoice-line-finder.js';
import { groupRows, findFields, findCisDeductions } from '../public/js/invoice-field-finder.js';
import { liveChecks, cisChecks } from '../public/js/entry-checks.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';

const { planCorrespondents } = syncSvc;
const { invoiceProblems } = entrySvc;
const { makeMockClient, resetMockPaperless, mockPaperlessState } = mockPaperless;

// A small in-memory model for the queries these services make
function fakeModel(rows) {
  const get = (o, k) => k.split('.').reduce((v, p) => v?.[p], o);
  const set = (o, k, v) => { const ps = k.split('.'); const last = ps.pop(); ps.reduce((x, p) => (x[p] ??= {}), o)[last] = v; };
  const match = (row, q) => Object.entries(q || {}).every(([k, v]) => {
    if (k === '$or') return v.some((sub) => match(row, sub));
    const val = get(row, k);
    if (v instanceof RegExp) return v.test(val ?? '');
    if (v && typeof v === 'object' && '$ne' in v) return val !== v.$ne;
    if (v && typeof v === 'object' && '$nin' in v) return !v.$nin.includes(val ?? null);
    return val === v;
  });
  const query = (res) => ({ select() { return this; }, sort() { return this; }, lean: async () => structuredClone(res) });
  return {
    rows,
    findOne: (q) => query(rows.find((r) => match(r, q)) ?? null),
    find: (q) => query(rows.filter((r) => match(r, q))),
    findOneAndUpdate: (q, upd) => ({
      lean: async () => {
        const r = rows.find((x) => match(x, q));
        if (!r) return null;
        for (const [k, v] of Object.entries(upd.$set || {})) set(r, k, v);
        for (const [k, v] of Object.entries(upd.$push || {})) (r[k] ||= []).push(v);
        return structuredClone(r);
      },
    }),
    updateMany: async (q, upd) => {
      let n = 0;
      for (const r of rows) if (match(r, q)) { for (const [k, v] of Object.entries(upd.$set)) set(r, k, v); n += 1; }
      return { modifiedCount: n };
    },
  };
}

describe('correspondents named "<Name> (<Code>)"', () => {
  it('labels a supplier and reads the code back', () => {
    assert.equal(correspondentLabel({ Name: 'Acme  Builders Ltd', Code: 'ACM01' }), 'Acme Builders Ltd (ACM01)');
    assert.deepEqual(parseCorrespondentName('Acme Builders Ltd (ACM01)'), { name: 'Acme Builders Ltd', code: 'ACM01' });
    assert.deepEqual(parseCorrespondentName('Acme Builders'), { name: 'Acme Builders', code: null });
    assert.equal(correspondentLabel({ Name: 'x'.repeat(200), Code: 'LONG1' }).length, 128, 'fits Paperless');
    assert.match(correspondentLabel({ Name: 'x'.repeat(200), Code: 'LONG1' }), /\(LONG1\)$/, 'the code is never cut');
  });

  it('finds the supplier by the code, then by name', async () => {
    const Supplier = fakeModel([
      { Code: 'ACM01', Name: 'Acme Builders Ltd' },
      { Code: 'NPH01', Name: 'Northern Plant Hire' },
    ]);
    assert.equal((await supplierFor(Supplier, 'Something else entirely (ACM01)')).Code, 'ACM01', 'the code wins over the name');
    assert.equal((await supplierFor(Supplier, 'Northern Plant Hire')).Code, 'NPH01', 'a hand-made name still matches');
    assert.equal((await supplierFor(Supplier, 'Northern Plant Hire (UNKNOWN)')).Code, 'NPH01', 'brackets that are not a code fall back to the name');
    assert.equal(await supplierFor(Supplier, 'Nobody'), null);
  });

  it('asks rather than guesses when two suppliers share the name', async () => {
    const Supplier = fakeModel([
      { Code: 'TYR02', Name: 'Valley Tyres' },
      { Code: 'TYR01', Name: 'Valley Tyres' },
      { Code: 'ACM01', Name: 'Acme Builders Ltd' },
    ]);
    const m = await supplierMatch(Supplier, 'Valley Tyres');
    assert.equal(m.supplier, null);
    assert.deepEqual(m.choices.map((s) => s.Code), ['TYR01', 'TYR02'], 'both offered, in code order');
    assert.equal(await supplierFor(Supplier, 'Valley Tyres'), null, 'never the first one the database returns');
    assert.equal((await supplierFor(Supplier, 'Valley Tyres (TYR02)')).Code, 'TYR02', 'a code settles it');
    assert.deepEqual((await supplierMatch(Supplier, 'Acme Builders Ltd')).choices, [], 'one match asks nothing');
  });

  it('takes the only active one when the other is archived', async () => {
    const Supplier = fakeModel([
      { Code: 'TYR01', Name: 'Valley Tyres', IsArchived: true },
      { Code: 'TYR02', Name: 'Valley Tyres' },
    ]);
    const m = await supplierMatch(Supplier, 'Valley Tyres');
    assert.equal(m.supplier.Code, 'TYR02');
    assert.deepEqual(m.choices, []);
  });
});

describe('planCorrespondents (the sync and the one-off rename)', () => {
  const suppliers = [
    { Name: 'Acme Builders Ltd', Code: 'ACM01' },     // hand-made "Acme Builders" exists
    { Name: 'Northern Plant Hire', Code: 'NPH01' },   // already coded, but renamed in KashFlow since
    { Name: 'Brand New Supplies', Code: 'BNS01' },    // nothing yet
    { Name: 'Twin Ltd', Code: 'TWN01' },              // "Twin" could be either of these two
    { Name: 'Twin Limited', Code: 'TWN02' },
    { Name: 'Steady Ltd', Code: 'STD01' },            // already right
  ];
  const correspondents = [
    { id: 1, name: 'Acme Builders' },
    { id: 2, name: 'Northern Plant (NPH01)' },
    { id: 3, name: 'Twin' },
    { id: 4, name: 'Steady Ltd (STD01)' },
    { id: 5, name: 'HMRC' },
  ];

  it('creates missing ones coded, follows KashFlow renames, and leaves hand-made ones unless asked', () => {
    const p = planCorrespondents(suppliers, correspondents);
    assert.deepEqual(p.create, ['Brand New Supplies (BNS01)']);
    assert.deepEqual(p.rename, [{ id: 2, from: 'Northern Plant (NPH01)', to: 'Northern Plant Hire (NPH01)', why: 'kashflow' }]);
    assert.deepEqual(p.matched, [{ id: 1, name: 'Acme Builders', to: 'Acme Builders Ltd (ACM01)' }]);
    assert.deepEqual(p.ambiguous, [{ id: 3, name: 'Twin', codes: ['TWN01', 'TWN02'] }]);
    assert.equal(p.inStep, 1);
  });

  it('renames matching hand-made ones when asked, never an ambiguous one or a non-supplier', () => {
    const p = planCorrespondents(suppliers, correspondents, { renameMatched: true });
    assert.deepEqual(p.rename.map((r) => [r.id, r.to, r.why]), [[1, 'Acme Builders Ltd (ACM01)', 'matched'], [2, 'Northern Plant Hire (NPH01)', 'kashflow']]);
    assert.ok(!p.rename.some((r) => r.id === 3 || r.id === 5));
  });

  it('changes nothing the second time', () => {
    const after = [
      { id: 1, name: 'Acme Builders Ltd (ACM01)' }, { id: 2, name: 'Northern Plant Hire (NPH01)' }, { id: 3, name: 'Twin' },
      { id: 4, name: 'Steady Ltd (STD01)' }, { id: 5, name: 'HMRC' }, { id: 6, name: 'Brand New Supplies (BNS01)' },
    ];
    const p = planCorrespondents(suppliers, after, { renameMatched: true });
    assert.deepEqual([p.create, p.rename], [[], []]);
  });
});

describe('assignSupplier (entry screen → Paperless correspondent)', () => {
  let api;
  let OcrDocument;
  let Supplier;
  const actor = { userId: null, name: 'bev' };

  beforeEach(() => {
    resetMockPaperless();
    api = makeMockClient();
    Supplier = fakeModel([
      { Code: 'ACM01', Name: 'Acme Builders Merchants' },
      { Code: 'NEW01', Name: 'Brand New Supplies' },
      { Code: 'OLD01', Name: 'Gone Ltd', IsArchived: true },
    ]);
    OcrDocument = fakeModel([
      { paperlessId: 9002, correspondent: { id: 2, name: 'Northern Plant Hire' }, processingState: 'awaiting_entry' },
      { paperlessId: 9003, correspondent: { id: 1, name: 'Acme Builders Merchants' }, processingState: 'entered' },
      { paperlessId: 9004, correspondent: null, processingState: 'sent', kashflowPurchaseId: 5, kashflowPurchaseNumber: 77 },
    ]);
  });

  it('renames the matching hand-made correspondent to carry the code, and sets it everywhere', async () => {
    const r = await assignSupplier({ OcrDocument, Supplier }, 9002, 'ACM01', actor, { api });
    assert.deepEqual([r.ok, r.how, r.to], [true, 'renamed', 'Acme Builders Merchants (ACM01)']);
    const state = mockPaperlessState();
    assert.equal(state.correspondents.find((c) => c.id === 1).name, 'Acme Builders Merchants (ACM01)');
    assert.equal(state.documents.find((d) => d.id === 9002).correspondent, 1, 'set in Paperless');
    const doc = OcrDocument.rows.find((d) => d.paperlessId === 9002);
    assert.deepEqual(doc.correspondent, { id: 1, name: 'Acme Builders Merchants (ACM01)' });
    assert.deepEqual([doc.processingHistory[0].field, doc.processingHistory[0].action], ['correspondent', 'set_supplier']);
    assert.equal(OcrDocument.rows.find((d) => d.paperlessId === 9003).correspondent.name, 'Acme Builders Merchants (ACM01)', 'others on that correspondent follow');
  });

  it('creates the correspondent when there is none, and refuses archived, unknown and sent', async () => {
    const r = await assignSupplier({ OcrDocument, Supplier }, 9002, 'NEW01', actor, { api });
    assert.deepEqual([r.how, r.to], ['created', 'Brand New Supplies (NEW01)']);
    assert.ok(mockPaperlessState().correspondents.some((c) => c.name === 'Brand New Supplies (NEW01)'));
    assert.equal((await assignSupplier({ OcrDocument, Supplier }, 9002, 'OLD01', actor, { api })).reason, 'invalid-supplier');
    assert.equal((await assignSupplier({ OcrDocument, Supplier }, 9002, 'NOPE', actor, { api })).reason, 'invalid-supplier');
    assert.equal((await assignSupplier({ OcrDocument, Supplier }, 9004, 'ACM01', actor, { api })).reason, 'in-kashflow');
  });

  it('lists active suppliers for the picker as "<Name> (<Code>)"', async () => {
    assert.deepEqual((await supplierOptions(Supplier)).map((s) => s.label), ['Acme Builders Merchants (ACM01)', 'Brand New Supplies (NEW01)']);
  });
});

describe('a subcontractor invoice\'s CIS deduction', () => {
  // Labour 1,000 + materials 50 = gross 1,050; CIS 20% of the labour = 200; left to pay 850
  const rows = [
    ['Invoice number 7'],
    ['Gross =', '£ 1050.00', '(Labour before tax deductions + Materials)'],
    ['Total materials - £50.00'],
    ['CIS Deductions @ 20% = £200.00'],
    ['Invoice Total - £850.00'],
  ];
  const items = rows.flatMap((cells, i) => {
    let x = 40;
    return cells.map((str) => { const it = { str, x, y: 700 - i * 14, w: str.length * 5, h: 10, page: 1 }; x += str.length * 5 + 20; return it; });
  });

  it('is found, but not in a "before deductions" note', () => {
    assert.deepEqual([...findCisDeductions(items)], ['200.00']);
  });

  it('is never VAT, and the invoice total is the gross before it', () => {
    const f = findFields(items);
    assert.equal(f.invoiceTotal.value, '1050.00');
    assert.equal(f.totalVat, null);
  });

  it('is explained when typed as VAT or taken off the total, instead of "doesn\'t add up"', () => {
    const asVat = liveChecks({ totalGoods: '1050', totalVat: '200', invoiceTotal: '1050' }, [{ description: 'Labour', total: '1000', vatRate: '20' }, { description: 'Materials', total: '50', vatRate: '20' }], { labour: 1000, cisPct: 20 });
    assert.equal(asVat.length, 1);
    assert.match(asVat[0], /is the CIS deduction \(20% of the labour\). CIS isn't VAT/);
    const after = liveChecks({ totalGoods: '1050', totalVat: '', invoiceTotal: '850' }, [], { labour: 1000, cisPct: 20 });
    assert.deepEqual(after, ["The invoice total £850.00 is what's left after the £200.00 CIS deduction. Enter the gross, £1,050.00: the CIS comes off when it's paid."]);
    // Both at once, as on the screen that prompted this
    assert.equal(cisChecks({ totalGoods: '1050', totalVat: '200', invoiceTotal: '850' }, 1000, 20).messages.length, 2);
    // Without a CIS rate it's the plain check
    assert.match(liveChecks({ totalGoods: '1050', totalVat: '0', invoiceTotal: '850' }, [])[0], /not the invoice total/);
  });

  it('is explained on the server too', () => {
    const entry = { labour: 1000, totalGoods: 1050, totalVat: 200, invoiceTotal: 850, lines: [{ total: 1000, vatRate: 20, role: 'labour' }, { total: 50, vatRate: 20, role: 'materials' }] };
    const w = entrySvc.consistencyWarnings(entry, { cisPct: 20 });
    assert.equal(w.length, 2);
    assert.ok(!w.some((m) => /line rates|not the invoice total/.test(m)));
  });
});

describe('invoiceProblems (what an invoice legally needs)', () => {
  const company = { names: ['Example Construction LTD', 'Example CS'], address: '1 Main Street, Sampletown, ST1 2AB' };
  const good = 'Northern Plant Hire, 5 Yard Lane, Othertown OT9 8ZZ\nInvoice No NPH-778\nTo: Example Construction Ltd, 1 Main Street, ST1 2AB\nVAT Reg 123 4567 89';

  it('has nothing to say about a complete invoice', () => {
    assert.deepEqual(invoiceProblems({ ocrText: good, docVatNumbers: ['123456789'], values: { invoiceNumber: 'NPH-778', invoiceDate: '2026-09-05', totalVat: '40' }, company }), []);
  });

  it('flags an email-style invoice with no number, date, addresses or customer', () => {
    const p = invoiceProblems({ ocrText: 'From: someone\nMonday\nLabour - £100.00', values: {}, company });
    assert.equal(p.length, 5);
    assert.match(p.join(' '), /No invoice number/);
    assert.match(p.join(' '), /No invoice date/);
    assert.match(p.join(' '), /No supplier address/);
    assert.match(p.join(' '), /doesn't name us/);
    assert.match(p.join(' '), /doesn't show our address/);
  });

  it('flags a number that is not on the document, and VAT without a VAT number', () => {
    const p = invoiceProblems({ ocrText: good, values: { invoiceNumber: 'XYZ-1', invoiceDate: '2026-09-05', totalVat: '40' }, company });
    assert.match(p[0], /XYZ-1\) isn't on the document/);
    assert.match(p[1], /no VAT number on it/);
  });

  it('accepts the short name, and stays quiet with no text or no company set', () => {
    assert.deepEqual(invoiceProblems({ ocrText: good.replace('Example Construction Ltd', 'Example CS'), docVatNumbers: ['123456789'], values: { invoiceNumber: 'NPH-778', invoiceDate: '2026-09-05' }, company }), []);
    assert.deepEqual(invoiceProblems({ ocrText: '', values: {}, company }), []);
    assert.ok(!invoiceProblems({ ocrText: good, values: { invoiceNumber: 'NPH-778', invoiceDate: 'x' } }).some((m) => /name us|our address/.test(m)));
  });
});

describe('day-by-day subcontractor invoices', () => {
  // One text item per row, top to bottom, as an emailed invoice prints
  const page = (rows) => rows.map((str, i) => ({ str, x: 40, y: 800 - i * 14, w: str.length * 5, h: 10, page: 1 }));
  const invoice = page([
    'Fw: Invoice',
    'Hi, please see below',
    '3rd March 2026',
    'Sample Road/Yard',
    'Labour - £250.00',
    '4th March 2026',
    'Test Lane, Exampleton/ Builders Merchants',
    'Labour 260.50',
    'Materials - Sand, cement - £12.00',
    '5th and 6th March 2026',
    'Other Street',
    'Labour - £1,000.00',
    'Thanks',
  ]);

  it('makes each day a line, and a day with labour and materials two', () => {
    const lines = findDayLines(groupRows(invoice));
    assert.deepEqual(lines.map((l) => [l.description, l.total, l.role]), [
      ['3rd March 2026 – Sample Road/Yard', 250, 'labour'],
      ['4th March 2026 – Test Lane, Exampleton/ Builders Merchants', 260.5, 'labour'],
      ['4th March 2026 – Materials: Sand, cement', 12, 'materials'],
      ['5th and 6th March 2026 – Other Street', 1000, 'labour'],
    ]);
    assert.ok(lines.every((l) => l.quantity === 1 && l.price === l.total && l.box));
  });

  it('is what findLines gives when there is no table', () => {
    assert.equal(findLines(invoice).length, 4);
  });

  // The month's summary under the last day, as these invoices print it
  const withSummary = [
    ...invoice.slice(0, -1),
    { str: 'th', x: 44, y: 600, w: 8, h: 6, page: 1 }, // a superscript "th" lands on a row of its own
    ...page(['Invoice number 7', 'Labour - £1,510.50', 'Gross =', 'Total materials - £12.00', 'CIS Deductions @ 20% = £302.10', 'Invoice Total - £1,220.40'])
      .map((it) => ({ ...it, y: it.y - 230 })),
  ];

  it('stops at the invoice\'s summary, so its labour total is not another line', () => {
    const lines = findDayLines(groupRows(withSummary));
    assert.equal(lines.length, 4);
    assert.ok(!lines.some((l) => l.total === 1510.5));
  });

  it('reads nothing without a date heading, so ordinary text is left alone', () => {
    assert.deepEqual(findDayLines(groupRows(page(['Labour - £250.00', 'Materials - £5.00']))), []);
  });
});
