import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import svc from '../mongoose/services/paperless/statementReadingService.js';

/**
 * A statement whose line table prints a branch code beside each document
 * number: "Date | Branch | Document Reference | Value | Payment Date |
 * Outstanding". KashFlow holds the supplier's reference as
 * "<branch>/<document number>". Everything here is made up.
 */

const BRANCH_STATEMENT = `Example Building Supplies Ltd
Example Building Centre, Any Road, Anytown AB1 2CD
STATEMENT
EXAMPLE CUSTOMER LTD
Anytown
1 Example Street Account Date Page
900123 02/11/2026 1
Please pay via the below A/C
Sort Code: 00-00-00
Date Branch Document Reference Value Payment Date Outstanding
01/10/2026 Inv 2207 05301101 MAIN STREET 12.50 12.50
05/10/2026 Inv 2207 05301145 HIGH ROAD 140.00 140.00
05/10/2026 Inv 2207 05301150 PARK LANE 22.10 22.10
06/10/2026 Cre 2207 05200077 PARK LANE -30.00 -30.00
07/10/2026 Inv 2207 05301190 MILL WAY 19.99 19.99
08/10/2026 Inv 2207 05301201 43 MILL WAY 8.40 8.40
Prior August September Current On Account Total
0.00 0.00 0.00 172.99 0.00 172.99
Please quote A/C No on payments All values are in Sterling`;

const DOC_NUMBERS = ['05301101', '05301145', '05301150', '05200077', '05301190', '05301201'];

const purchase = (n, ref, date, gross, extra = {}) => ({
  uuid: `u${n}`, Id: 2000 + n, Number: n, SupplierId: 9, SupplierCode: 'EXB01', SupplierName: 'Example Building Supplies Ltd',
  SupplierReference: ref, IssuedDate: new Date(date), GrossAmount: gross, DueAmount: 0, TotalPaidAmount: 0, Status: 'Outstanding', ...extra,
});

const KASHFLOW = [
  purchase(1, '2207/05301101', '2026-10-01', 12.5),
  purchase(2, '2207/05301145', '2026-10-05', 140),
  purchase(3, '2207/05301150', '2026-10-05', 22.1),
  purchase(4, '2207/05200077', '2026-10-06', -30),
  purchase(5, '2207/05301190', '2026-10-07', 19.99),
  purchase(6, '2207/05301201', '2026-10-08', 8.4),
  purchase(7, '2207/05290001', '2026-09-10', 64.2), // unpaid, not on the statement
];

describe('a statement with a branch column', () => {
  it('reads the document number as the reference, not the branch code', () => {
    const p = svc.parseStatement(BRANCH_STATEMENT);
    assert.deepEqual(p.lines.map((l) => l.ref), DOC_NUMBERS);
    assert.ok(p.lines.every((l) => l.prefix === '2207'), 'the branch is kept as the prefix');
    assert.deepEqual(p.lines.map((l) => l.kind), ['invoice', 'invoice', 'invoice', 'credit', 'invoice', 'invoice']);
    assert.deepEqual(p.lines.map((l) => l.amount), [12.5, 140, 22.1, -30, 19.99, 8.4]);
  });

  it('reads the header box date and the total under the ageing headings', () => {
    const p = svc.parseStatement(BRANCH_STATEMENT);
    assert.equal(p.header.statementDate, '2026-11-02');
    assert.equal(p.header.closingBalance, 172.99);
    assert.equal(p.unread, 0, 'the ageing figures are not an unread line');
  });

  it('matches each line to its own purchase, one to one', () => {
    const r = svc.reconcile(svc.parseStatement(BRANCH_STATEMENT), KASHFLOW);
    assert.deepEqual(r.matched.map((m) => [m.line, m.by, m.purchase.number, m.amountAgrees]), [
      [0, 'reference', 1, true],
      [1, 'reference', 2, true],
      [2, 'reference', 3, true],
      [3, 'reference', 4, true],
      [4, 'reference', 5, true],
      [5, 'reference', 6, true],
    ]);
    assert.equal(new Set(r.matched.map((m) => m.purchase.number)).size, r.matched.length);
    assert.deepEqual(r.onStatementOnly, []);
    assert.deepEqual(r.inKashflowOnly.map((p) => p.number), [7]);
    assert.equal(r.summary.amountDiffers, 0);
    assert.equal(r.balance.statement, 172.99);
  });

  it('never matches several lines to one purchase because they share a branch code', () => {
    // Only one purchase answers: the other lines must not be taken as parts of it
    const r = svc.reconcile(svc.parseStatement(BRANCH_STATEMENT), [KASHFLOW[0]]);
    assert.deepEqual(r.matched.map((m) => [m.line, m.purchase.number, m.parts]), [[0, 1, undefined]]);
    assert.equal(r.onStatementOnly.length, 5);
  });

  it('without the headings, a code repeated on every line is still taken as the branch', () => {
    const noHeadings = BRANCH_STATEMENT.split('\n').filter((l) => !l.startsWith('Date Branch')).join('\n');
    const p = svc.parseStatement(noHeadings);
    assert.deepEqual(p.lines.map((l) => l.ref), DOC_NUMBERS);
    const r = svc.reconcile(p, KASHFLOW);
    assert.equal(r.summary.matched, 6);
    assert.equal(r.matched.every((m) => m.by === 'reference'), true);
  });
});

describe('matching a reference across a separator', () => {
  it('scores the same, a tail after a separator either way round, then one inside the other', () => {
    assert.equal(svc.refMatchScore('05301101', '05301101'), 3);
    assert.equal(svc.refMatchScore('05301101', '2207/05301101'), 2);
    assert.equal(svc.refMatchScore('2207/05301101', '05301101'), 2);
    assert.equal(svc.refMatchScore('5301101', '2207/05301101'), 1);
    assert.equal(svc.refMatchScore('1101', '2207/1101'), 0, 'too short to go on alone');
    assert.equal(svc.refsMatch('05301101', '2207-05301101'), true);
  });

  it('a statement printing branch/number matches a KashFlow reference holding only the number', () => {
    const p = svc.parseStatement('Statement Date 31/10/2026\n01/10/2026 Inv 2207/05301101 12.50 12.50');
    const r = svc.reconcile(p, [purchase(1, '05301101', '2026-10-01', 12.5)]);
    assert.deepEqual(r.matched.map((m) => [m.by, m.purchase.number]), [['reference', 1]]);
  });

  it('branch and a short number in separate columns match the two together', () => {
    const p = svc.parseStatement(`Date Branch Doc No Value
01/10/2026 2207 1101 12.50
02/10/2026 2207 1102 7.00`);
    assert.deepEqual(p.lines.map((l) => [l.prefix, l.ref]), [['2207', '1101'], ['2207', '1102']]);
    const r = svc.reconcile(p, [purchase(1, '2207/1101', '2026-10-01', 99), purchase(2, '2207/1102', '2026-10-02', 7)]);
    assert.deepEqual(r.matched.map((m) => [m.line, m.by, m.purchase.number, m.amountAgrees]), [[0, 'reference', 1, false], [1, 'reference', 2, true]]);
  });

  it('a closer match is not lost to a looser one on an earlier line', () => {
    const p = svc.parseStatement('01/10/2026 AB-530110 5.00\n02/10/2026 530110 9.00');
    const r = svc.reconcile(p, [purchase(1, '530110', '2026-10-02', 9), purchase(2, 'AB-530110', '2026-10-01', 5)]);
    assert.deepEqual(r.matched.map((m) => [m.line, m.purchase.number]), [[0, 2], [1, 1]]);
  });
});

/**
 * An open-item statement: each line's last figure is what is still
 * outstanding on it, settled invoices aren't listed, and the foot is an
 * ageing table ending "TOTAL PAYABLE". Everything here is made up.
 */
const OPEN_ITEM_STATEMENT = `STATEMENT
Example Timber Co
Account EXT001 Statement Date 31/10/2026
DATE TYPE REFERENCE AMOUNT OUTSTANDING AMOUNT
03/10/2026 Receipt Bal 205.48 -0.08
15/10/2026 Invoice TI-77120 96.00 96.00
22/10/2026 Invoice TI-77188 48.50 48.50
Older 3 Months 2 Months 1 Month Current Month TOTAL PAYABLE
0.00 0.00 0.00 -0.08 144.50 144.42`;

describe('an open-item statement', () => {
  const kashflow = () => [
    // settled before the statement, so not listed on it; overpaid by 0.08, which KashFlow leaves as -0.08 owed
    purchase(11, 'TI-77001', '2026-09-20', 205.4, { TotalPaidAmount: 205.48, PaymentLines: [{ Date: new Date('2026-10-03'), Amount: 205.48 }] }),
    purchase(12, 'TI-77120', '2026-10-15', 96),
    purchase(13, 'TI-77188', '2026-10-22', 48.5),
  ];

  it('reads the total payable under the ageing headings as the balance, and knows it lists open items', () => {
    const p = svc.parseStatement(OPEN_ITEM_STATEMENT);
    assert.equal(p.header.closingBalance, 144.42);
    assert.equal(p.header.openItems, true);
    assert.equal(p.header.statementDate, '2026-10-31');
    assert.deepEqual(p.lines.map((l) => [l.kind, l.ref, l.amount, l.balance]), [
      ['payment', null, 205.48, -0.08],
      ['invoice', 'TI-77120', 96, 96],
      ['invoice', 'TI-77188', 48.5, 48.5],
    ]);
    assert.equal(p.unread, 0);
  });

  it('checks the balance, not the payments', () => {
    const r = svc.reconcile(svc.parseStatement(OPEN_ITEM_STATEMENT), kashflow());
    assert.deepEqual(r.balance, { statement: 144.42, kashflow: 144.42, agree: true });
    assert.equal(r.payments.agree, null);
    assert.equal(r.payments.openItems, true);
    assert.deepEqual(r.matched.map((m) => [m.line, m.by, m.purchase.number]), [[1, 'reference', 12], [2, 'reference', 13]]);
    assert.deepEqual(r.inKashflowOnly, []);
    assert.equal(r.summary.status, 'reconciled');
    assert.doesNotMatch(svc.summaryText({ hasText: true, supplier: {}, reconciliation: r }), /payments differ/);
  });

  it('a running-balance statement still compares payments', () => {
    assert.equal(svc.isOpenItemHeading('Date Reference Debit Credit Balance'), false);
    assert.equal(svc.isOpenItemHeading('Date Type Reference Amount Outstanding Amount'), true);
  });
});

describe('a dotted date in the details column', () => {
  const LINE = '30/09/2026 41187 04.09.26 330912 - Skip Hire 182.40 182.40';

  it('is a date, not an amount', () => {
    assert.deepEqual(svc.findMoney(LINE).map((m) => m.value), [182.4, 182.4]);
    assert.deepEqual(svc.findMoney('ref 1.2.34 then 5.00').map((m) => m.value), [5], 'a dotted number is not an amount either');
    assert.deepEqual(svc.findMoney('12.50 and 3.09').map((m) => m.value), [12.5, 3.09], 'plain amounts still read');
  });

  it('the line takes the debit as its amount and the last figure as its balance', () => {
    const p = svc.parseStatement(`Date Ref Details Debit Credit Balance\n${LINE}`);
    assert.deepEqual(p.lines.map((l) => [l.date, l.ref, l.amount, l.balance]), [['2026-09-30', '41187', 182.4, 182.4]]);
    const r = svc.reconcile(p, [purchase(1, '41187', '2026-09-30', 182.4)]);
    assert.deepEqual(r.matched.map((m) => [m.by, m.amountAgrees]), [['reference', true]]);
  });
});
