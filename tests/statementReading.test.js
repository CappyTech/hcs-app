import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { memoryModel } from './helpers/memoryModel.js';
import svc from '../mongoose/services/paperless/statementReadingService.js';
import { reviewNote } from '../mongoose/services/paperless/documentEntryService.js';
import queues from '../mongoose/services/paperless/documentQueueService.js';
import { entryKind, formValues } from '../mongoose/services/paperless/documentEntryService.js';
import fixtures from '../mongoose/services/paperless/mock/fixtures.js';

const require = createRequire(import.meta.url);
const ejs = require('ejs');

/** Supplier statement reconciliation (PAPERLESS-MIGRATION.md §8 item 6). All data here is made up. */

const STATEMENT = { id: 2, name: 'Supplier Statement' };
const PI = { id: 1, name: 'Purchase Invoice' };
const acme = fixtures.DOCUMENTS.find((d) => d.id === 9005);

// A statement of account with a printed period, a payment and a credit
const PERIOD_STATEMENT = `Example Supplies Ltd
Statement of Account
Statement Date 30/09/2026
Period 01/09/2026 to 30/09/2026
Date Reference Debit Credit Balance
02/09/2026 SI-4401 120.00 120.00
09/09/2026 SI-4418 45.50 165.50
15/09/2026 Payment received - thank you 120.00 45.50
22/09/2026 Credit note CN-0092 10.00 35.50
28/09/2026 SI-4450 99.99 135.49
Payments 120.00
Closing Balance 135.49
Page 1 of 1`;

// A prepaid account: lines are usage, the statement's payments are what matter
const PREPAID_STATEMENT = `Toll Account Statement
Statement No 0001
Statement Date 28/09/26
Billing Period 28/08/26-27/09/26
Previous Balance £50.00
Road User Charges -£60.00
Payments £100.00
Closing Balance £90.00
28/08/2026 AB12CDE Bridge N 28/08/2026 Video £2.00 £48.00
08/09/2026 Pre-Paid Toll Payment £100.00 Rebill £148.00
09/09/2026 AB12CDE Bridge S 09/09/2026 Video £2.00 £146.00`;

const purchase = (n, ref, date, gross, extra = {}) => ({
  uuid: `u${n}`, Id: 1000 + n, Number: n, SupplierId: 7, SupplierCode: 'EXA01', SupplierName: 'Example Supplies Ltd',
  SupplierReference: ref, IssuedDate: new Date(date), GrossAmount: gross, DueAmount: gross, TotalPaidAmount: 0, Status: 'Outstanding', ...extra,
});

describe('reading the text of a statement', () => {
  it('finds dates, amounts and references on a line', () => {
    assert.deepEqual(svc.findDates('30 Sep 2026 and 01/10/26 and 2-Nov-2026').map((d) => d.value), ['2026-09-30', '2026-10-01', '2026-11-02']);
    assert.deepEqual(svc.findMoney('£1,234.56 -£12.00 (3.50) 4.00CR 5.00').map((m) => m.value), [1234.56, -12, -3.5, -4, 5]);
    assert.deepEqual(svc.findRefs('02/09/2026 SI-4401 120.00 at 10:15'), ['SI-4401']);
    assert.deepEqual(svc.findRefs('0767/08028363 and INV 12 and 260461'), ['0767/08028363', '260461']);
    assert.equal(svc.lineKind('15/09/2026 Payment received - thank you 120.00'), 'payment');
    assert.equal(svc.lineKind('22/09/2026 Credit note CN-0092 10.00'), 'credit');
    assert.equal(svc.lineKind('Closing Balance 135.49'), 'balance');
  });

  it('reads the mock statement: date, lines and balance', () => {
    const p = svc.parseStatement(acme.content);
    assert.equal(p.hasText, true);
    assert.equal(p.header.statementDate, '2026-09-30');
    assert.equal(p.header.closingBalance, 114);
    assert.deepEqual(p.lines.map((l) => [l.ref, l.amount, l.kind]), [['INV-1001', 78, 'invoice'], ['INV-1002', 36, 'invoice']]);
    assert.equal(p.unread, 0);
  });

  it('reads a printed period, payments and credits', () => {
    const p = svc.parseStatement(PERIOD_STATEMENT);
    assert.equal(p.header.periodStart, '2026-09-01');
    assert.equal(p.header.periodEnd, '2026-09-30');
    assert.equal(p.header.periodSource, 'printed');
    assert.equal(p.header.paymentsTotal, 120);
    assert.equal(p.header.closingBalance, 135.49);
    assert.deepEqual(p.lines.map((l) => [l.date, l.ref, l.amount, l.kind]), [
      ['2026-09-02', 'SI-4401', 120, 'invoice'],
      ['2026-09-09', 'SI-4418', 45.5, 'invoice'],
      ['2026-09-15', null, 120, 'payment'],
      ['2026-09-22', 'CN-0092', 10, 'credit'],
      ['2026-09-28', 'SI-4450', 99.99, 'invoice'],
    ]);
    // The column-heading row has no amount, so it isn't a line
    assert.ok(!p.lines.some((l) => /Reference Debit/.test(l.raw)));
  });

  it('reads a prepaid statement: the previous balance is not the closing one, and the period is the printed one', () => {
    const p = svc.parseStatement(PREPAID_STATEMENT);
    assert.equal(p.header.statementDate, '2026-09-28');
    assert.equal(p.header.periodStart, '2026-08-28');
    assert.equal(p.header.periodEnd, '2026-09-27');
    assert.equal(p.header.closingBalance, 90);
    assert.equal(p.header.paymentsTotal, 100);
    assert.equal(p.lines.filter((l) => l.kind === 'payment').length, 1);
    assert.equal(p.lines.filter((l) => l.kind === 'invoice').length, 2);
  });

  it('a statement with no text, or nothing to read, says so rather than failing', () => {
    assert.deepEqual(svc.parseStatement('').lines, []);
    assert.equal(svc.parseStatement('').hasText, false);
    const p = svc.parseStatement('Dear customer\nPlease find your statement\n£12.00');
    assert.equal(p.lines.length, 0);
    assert.equal(p.unread, 1, 'an amount with nothing to tie it to is counted, not dropped');
  });

  it('takes the period from the dated lines when none is printed', () => {
    const p = svc.parseStatement('Statement 30/09/2026\n02/09/2026 A-1 10.00\n20/09/2026 A-2 20.00');
    assert.equal(p.header.periodStart, '2026-09-02');
    assert.equal(p.header.periodEnd, '2026-09-30', 'runs to the statement date');
    assert.equal(p.header.periodSource, 'lines');
  });
});

describe('setting a statement against purchases', () => {
  it('matches by reference first, then by amount and date; each purchase once', () => {
    const parsed = svc.parseStatement(PERIOD_STATEMENT);
    const r = svc.reconcile(parsed, [
      purchase(1, 'SI-4401', '2026-09-02', 120),
      purchase(2, 'si 4418', '2026-09-09', 45.5), // same reference, printed differently
      purchase(3, 'POD 991', '2026-09-27', 99.99), // only the amount and date match
      purchase(4, '', '2026-09-27', 99.99), // a second candidate: the closer date wins (3 is one day off, 4 is one day off too; 3 is first)
    ]);
    assert.deepEqual(r.matched.map((m) => [m.line, m.by, m.purchase.number]), [[0, 'reference', 1], [1, 'reference', 2], [4, 'amount', 3]]);
    assert.deepEqual(r.onStatementOnly, [3], 'the credit note has no purchase');
    assert.equal(r.summary.status, 'differences');
    assert.equal(r.summary.matched, 3);
  });

  it('refs match when one is inside the other and long enough', () => {
    assert.equal(svc.refsMatch('0767/08028363', '08028363'), true);
    assert.equal(svc.refsMatch('INV-1001', 'INV1001'), true);
    assert.equal(svc.refsMatch('1001', 'INV-1001'), false, 'four characters is too little to go on');
    assert.equal(svc.refsMatch('', 'INV-1001'), false);
  });

  it('lists purchases inside a printed period that the statement leaves out', () => {
    const parsed = svc.parseStatement(PERIOD_STATEMENT);
    const r = svc.reconcile(parsed, [
      purchase(1, 'SI-4401', '2026-09-02', 120),
      purchase(2, 'SI-4418', '2026-09-09', 45.5),
      purchase(3, 'SI-4450', '2026-09-28', 99.99),
      purchase(5, 'SI-4433', '2026-09-18', 33, { DueAmount: 0, Status: 'Paid' }), // in the period, not listed
      purchase(6, 'SI-4390', '2026-08-20', 70), // before the period
    ]);
    assert.deepEqual(r.inKashflowOnly.map((p) => p.number), [5]);
    assert.equal(r.summary.inKashflowOnly, 1);
    assert.equal(r.period.source, 'printed');
  });

  it('without a printed period, lists what is still unpaid in KashFlow up to the statement date', () => {
    const parsed = svc.parseStatement(acme.content);
    const r = svc.reconcile(parsed, [
      purchase(1, 'INV-1001', '2026-09-01', 78),
      purchase(2, 'INV-1002', '2026-09-10', 36),
      purchase(3, 'INV-0990', '2026-08-01', 50), // unpaid, not on the statement
      purchase(4, 'INV-0980', '2026-07-01', 20, { DueAmount: 0, Status: 'Paid' }), // paid, so not expected on it
      purchase(5, 'INV-1010', '2026-10-05', 15), // after the statement date
    ]);
    assert.deepEqual(r.inKashflowOnly.map((p) => p.number), [3]);
    assert.equal(r.balance.statement, 114);
    assert.equal(r.balance.kashflow, 164, 'everything unpaid up to the statement date');
    assert.equal(r.balance.agree, false);
  });

  it('compares the payments the statement received with the payment lines in KashFlow', () => {
    const parsed = svc.parseStatement(PERIOD_STATEMENT);
    const paid = { DueAmount: 0, TotalPaidAmount: 120, Status: 'Paid', PaymentLines: [{ Date: new Date('2026-09-15'), Amount: 120 }] };
    const r = svc.reconcile(parsed, [purchase(1, 'SI-4401', '2026-09-02', 120, paid), purchase(2, 'SI-4418', '2026-09-09', 45.5), purchase(3, 'SI-4450', '2026-09-28', 99.99)]);
    assert.deepEqual(r.payments, { statement: 120, kashflow: 120, agree: true });
    const r2 = svc.reconcile(parsed, [purchase(1, 'SI-4401', '2026-09-02', 120), purchase(2, 'SI-4418', '2026-09-09', 45.5), purchase(3, 'SI-4450', '2026-09-28', 99.99)]);
    assert.deepEqual(r2.payments, { statement: 120, kashflow: 0, agree: false });
    assert.match(svc.summaryText({ hasText: true, supplier: {}, reconciliation: r2 }), /payments differ/);
  });

  it('a prepaid account: the usage lines match nothing, but the payments check holds', () => {
    const parsed = svc.parseStatement(PREPAID_STATEMENT);
    const topUp = purchase(9, '12345', '2026-09-08', 100, { DueAmount: 0, TotalPaidAmount: 100, Status: 'Paid', PaymentLines: [{ Date: new Date('2026-09-08'), Amount: 100 }] });
    const r = svc.reconcile(parsed, [topUp]);
    assert.equal(r.summary.onStatementOnly, 2);
    assert.deepEqual(r.payments, { statement: 100, kashflow: 100, agree: true });
    assert.equal(r.inKashflowOnly.length, 0, 'the top-up is on the statement as a payment, not an invoice');
    assert.deepEqual(r.matched.map((m) => [m.by, m.purchase.number]), [['payment', 9]]);
    assert.equal(r.summary.paymentsMatched, 1);
    assert.equal(r.summary.matched, 0);
  });

  it('says it in one line', () => {
    const parsed = svc.parseStatement(acme.content);
    const all = svc.reconcile(parsed, [purchase(1, 'INV-1001', '2026-09-01', 78), purchase(2, 'INV-1002', '2026-09-10', 36)]);
    assert.equal(svc.summaryText({ hasText: true, supplier: {}, reconciliation: all }), '2 matched');
    assert.equal(all.summary.status, 'reconciled');
    const some = svc.reconcile(parsed, [purchase(1, 'INV-1001', '2026-09-01', 78), purchase(3, 'INV-0990', '2026-08-01', 50)]);
    assert.equal(svc.summaryText({ hasText: true, supplier: {}, reconciliation: some }), '1 matched, 1 on statement only, 1 in KashFlow only');
    assert.equal(svc.summaryText({ hasText: true, supplier: null }), 'No KashFlow supplier for this correspondent');
    assert.equal(svc.summaryText({ error: 'boom' }), "Couldn't read: boom");
    assert.equal(svc.summaryText(null), null);
  });
});

describe('reading a statement document', () => {
  const models = (seed = {}) => ({
    OcrDocument: memoryModel(seed.docs || [
      { paperlessId: 9005, correspondent: { id: 1, name: 'Acme Builders Merchants' }, documentType: STATEMENT, ocrText: acme.content, statementReviewed: false, deletedInPaperlessAt: null, classifiedAt: new Date('2026-10-01'), added: new Date('2026-09-30') },
      { paperlessId: 9001, correspondent: { id: 1, name: 'Acme Builders Merchants' }, documentType: PI, ocrText: 'Invoice INV-1001', processingState: 'awaiting_entry', deletedInPaperlessAt: null },
    ]),
    Supplier: memoryModel(seed.suppliers || [{ Id: 7, Code: 'ACM01', Name: 'Acme Builders Merchants' }]),
    Purchase: memoryModel(seed.purchases || [
      { ...purchase(1, 'INV-1001', '2026-09-01', 78), SupplierId: 7, SupplierCode: 'ACM01', SupplierName: 'Acme Builders Merchants' },
      { ...purchase(2, 'INV-1002', '2026-09-10', 36), SupplierId: 7, SupplierCode: 'ACM01', SupplierName: 'Acme Builders Merchants' },
      purchase(3, 'INV-1002', '2026-09-10', 36, { SupplierId: 8, SupplierCode: 'OTH01', SupplierName: 'Other Supplies' }), // another supplier's, same reference
    ]),
  });
  const deps = (m) => ({ connect: null, models: () => m, now: () => new Date('2026-10-06T10:00:00Z') });

  it('reads, matches the supplier by correspondent name and stores the result on the document', async () => {
    const m = models();
    const st = await svc.readStatement(9005, deps(m));
    assert.equal(st.version, svc.STATEMENT_READER_VERSION);
    assert.deepEqual(st.supplier, { id: 7, code: 'ACM01', name: 'Acme Builders Merchants' });
    assert.equal(st.purchaseCount, 2, 'only this supplier\'s purchases');
    assert.equal(st.reconciliation.summary.status, 'reconciled');
    assert.equal(st.summaryText, '2 matched');
    assert.equal(m.OcrDocument.docs[0].statement.summaryText, '2 matched');
    assert.equal(svc.needsReading(m.OcrDocument.docs[0]), false);
  });

  it('is a no-op for anything but a supplier statement', async () => {
    const m = models();
    assert.equal(await svc.readStatement(9001, deps(m)), null);
    assert.equal(await svc.readStatement(4242, deps(m)), null);
    assert.equal(m.OcrDocument.docs[1].statement, undefined);
  });

  it('with no KashFlow supplier for the correspondent, says so and stores no reconciliation', async () => {
    const m = models({ suppliers: [] });
    const st = await svc.readStatement(9005, deps(m));
    assert.equal(st.supplier, null);
    assert.equal(st.reconciliation, null);
    assert.equal(st.lineCount, 2, 'the lines are still read');
    assert.equal(st.summaryText, 'No KashFlow supplier for this correspondent');
  });

  it('a failure is stored as an error, not thrown', async () => {
    const m = models();
    m.Supplier.findOne = () => { throw new Error('REST down'); };
    m.Supplier.find = () => { throw new Error('REST down'); };
    const st = await svc.readStatement(9005, deps(m));
    assert.equal(st.error, 'REST down');
    assert.match(st.summaryText, /Couldn't read/);
    assert.equal(svc.needsReading({ statement: st }), false, 'an error from the current reader is not retried on every page view');
  });

  it('readMissing reads the statements waiting for review that have no reading or an old one', async () => {
    const m = models({ docs: [
      { paperlessId: 1, documentType: STATEMENT, correspondent: { name: 'Acme Builders Merchants' }, ocrText: acme.content, statementReviewed: false, deletedInPaperlessAt: null, added: new Date('2026-09-01') },
      { paperlessId: 2, documentType: STATEMENT, correspondent: { name: 'Acme Builders Merchants' }, ocrText: acme.content, statementReviewed: false, deletedInPaperlessAt: null, added: new Date('2026-09-02'), statement: { version: 0 } },
      { paperlessId: 3, documentType: STATEMENT, correspondent: { name: 'Acme Builders Merchants' }, ocrText: acme.content, statementReviewed: true, deletedInPaperlessAt: null, added: new Date('2026-09-03') },
      { paperlessId: 4, documentType: STATEMENT, correspondent: { name: 'Acme Builders Merchants' }, ocrText: acme.content, statementReviewed: false, deletedInPaperlessAt: null, added: new Date('2026-09-04'), statement: { version: svc.STATEMENT_READER_VERSION } },
      { paperlessId: 5, documentType: PI, ocrText: '', processingState: 'awaiting_entry', deletedInPaperlessAt: null, added: new Date('2026-09-05') },
    ] });
    const r = await svc.readMissing({ limit: 20 }, deps(m));
    assert.equal(r.read, 2);
    assert.ok(m.OcrDocument.docs[0].statement.summaryText);
    assert.equal(m.OcrDocument.docs[1].statement.version, svc.STATEMENT_READER_VERSION);
    assert.equal(m.OcrDocument.docs[2].statement, undefined, 'reviewed ones are left alone');
  });
});

describe('marking reviewed records how it stood', () => {
  it('the history note carries the summary and when it was checked', () => {
    assert.equal(reviewNote({ summaryText: '2 matched', at: new Date('2026-10-06T10:00:00Z') }), 'Against KashFlow: 2 matched (checked 2026-10-06)');
    assert.equal(reviewNote({ summaryText: '1 matched, 1 on statement only' }), 'Against KashFlow: 1 matched, 1 on statement only');
    assert.equal(reviewNote(null), null);
    assert.equal(reviewNote({}), null);
  });
});

describe('the views', () => {
  const queueView = path.resolve('mongoose/views/tailwindcss/paperless/queue.ejs');
  const renderQueue = (docs) => ejs.renderFile(queueView, {
    key: 'statements', queue: queues.QUEUES.statements, queues: queues.QUEUES, docs, total: docs.length, page: 1, pages: 1,
    counts: { 'needs-entry': 0, ready: 0, statements: docs.length, 'check-type': 0 }, unclassified: { invoices: 0, statements: 0 }, paperlessUiBase: '',
  });

  it('the Statements to Review queue shows how each statement stands against KashFlow', async () => {
    const html = await renderQueue([
      { paperlessId: 1, title: 'a.pdf', documentType: STATEMENT, added: new Date(), daysWaiting: 0, statement: { summaryText: '2 matched', reconciliation: { summary: { status: 'reconciled' } } } },
      { paperlessId: 2, title: 'b.pdf', documentType: STATEMENT, added: new Date(), daysWaiting: 0, statement: { summaryText: '1 matched, 1 on statement only', reconciliation: { summary: { status: 'differences' } } } },
      { paperlessId: 3, title: 'c.pdf', documentType: STATEMENT, added: new Date(), daysWaiting: 0 },
    ]);
    assert.match(html, /Against KashFlow/);
    assert.match(html, /data-statement-status="reconciled"[^>]*>[\s\S]*?2 matched/);
    assert.match(html, /data-statement-status="differences"[^>]*>[\s\S]*?1 on statement only/);
    assert.match(html, /data-statement-status="none"[^>]*>[\s\S]*?Not checked yet/);
    assert.ok(queues.QUEUES.statements.filter, 'queue still defined');
  });

  it('the entry screen shows the differences, the balance and payments, and a check-again button', async () => {
    const view = path.resolve('mongoose/views/tailwindcss/paperless/entry.ejs');
    const parsed = svc.parseStatement(PERIOD_STATEMENT);
    const reconciliation = svc.reconcile(parsed, [purchase(1, 'SI-4401', '2026-09-02', 120), purchase(5, 'SI-4433', '2026-09-18', 33)]);
    const doc = {
      paperlessId: 9005, title: 'Statement.pdf', documentType: STATEMENT, correspondent: { name: 'Example Supplies Ltd' }, ocrText: PERIOD_STATEMENT, customFields: [],
      statementReviewed: false, classifiedAt: new Date(),
      statement: { version: 1, at: new Date('2026-10-06T10:00:00Z'), hasText: true, supplier: { id: 7, code: 'EXA01', name: 'Example Supplies Ltd' }, header: parsed.header, lines: parsed.lines, lineCount: parsed.lines.length, unread: 0, purchaseCount: 2, reconciliation, summaryText: svc.summaryText({ hasText: true, supplier: {}, reconciliation }) },
    };
    const html = await ejs.renderFile(view, {
      title: 'Statement.pdf', csrfToken: 'tok', errors: {}, warnings: [], isAdmin: false, locked: false, paperlessUiBase: '', lineCount: 1,
      doc, kind: entryKind(doc), values: formValues(doc),
    });
    assert.match(html, /data-statement-check="differences"/);
    assert.match(html, /On the statement, not in KashFlow \(3\)/);
    assert.match(html, /SI-4418/);
    assert.match(html, /In KashFlow, not on the statement \(1\)/);
    assert.match(html, /href="\/purchase\/read\/u5"/);
    assert.match(html, /Matched \(1\)/);
    assert.match(html, /action="\/paperless\/ocr\/9005\/statement-check"/);
    assert.match(html, /action="\/paperless\/ocr\/9005\/reviewed"/);
    assert.match(html, /Statement says <strong>£135\.49<\/strong>/);
    assert.match(html, /Statement received <strong>£120\.00<\/strong>/);
    assert.match(html, /data-payments-agree="false"/);

    const unread = await ejs.renderFile(view, {
      title: 'Statement.pdf', csrfToken: 'tok', errors: {}, warnings: [], isAdmin: false, locked: false, paperlessUiBase: '', lineCount: 1,
      doc: { ...doc, statement: undefined }, kind: 'statement', values: formValues(doc),
    });
    assert.match(unread, /data-statement-check="none"/);
    assert.match(unread, /Not checked yet/);
  });
});
