import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toItems } from '../public/js/invoice-field-finder.js';
import lineFinder from '../public/js/invoice-line-finder.js';

const { findLines, fillMissingRates, findPaymentTerms, findVatNumbers, normaliseVatNumber, parseNumber } = lineFinder;

// [str, x, y, width, height] as PDF.js reports them, page 1
const page = (rows) => toItems(rows.map(([str, x, y, w, h]) => ({ str, transform: [h, 0, 0, h, x, y], width: w, height: h })), 1);
const brief = (lines) => lines.map((l) => [l.description, l.quantity, l.price, l.total, l.vatRate]);

describe('line items', () => {
  it('Duttons: one row per line, VAT as an amount', () => {
    const lines = findLines(page([
      ['Part No.', 39, 559, 36, 10], ['Description', 137, 559, 50, 10], ['Price', 360, 559, 23, 10], ['Qty', 417, 559, 15, 10], ['Goods', 466, 559, 29, 10], ['VAT', 539, 558, 19, 10],
      ['MJIADB20', 36, 544, 48, 10], ['Ad Blue 20L', 137, 543, 54, 10], ['£25.00', 356, 542, 30, 10], ['1.00', 413, 542, 19, 10], ['£25.00', 465, 543, 30, 10], ['£5.00', 533, 543, 25, 10],
      ['SAN3625', 36, 526, 43, 10], ['WASHED PLASTERING SAND Handy Bag (63 bag', 137, 526, 228, 10], ['£4.28', 361, 525, 25, 10], ['3.00', 413, 525, 19, 10], ['£12.85', 465, 526, 30, 10], ['£2.57', 533, 525, 25, 10],
      ['VAT SUMMARY', 36, 229, 74, 10], ['Total Goods', 360, 208, 54, 10], ['£37.85', 513, 208, 30, 10],
    ]));
    assert.deepEqual(brief(lines), [
      ['Ad Blue 20L', 1, 25, 25, 20],
      ['WASHED PLASTERING SAND Handy Bag (63 bag', 3, 4.28, 12.85, 20],
    ]);
    assert.equal(lines[0].code, 'MJIADB20');
    assert.ok(lines[0].box.x <= 36 && lines[0].box.x + lines[0].box.w >= 558);
  });

  it('Stark: description on one row, figures on the row below, VAT code "S"', () => {
    const lines = findLines(page([
      ['ITEM No.', 43.2, 554, 29.9, 7], ['DESCRIPTION', 97.2, 554, 47.8, 7], ['QUANTITY', 237.8, 554, 35.7, 7], ['PRICE', 338.6, 554, 21.4, 7], ['UNIT', 418.4, 554, 16.3, 7], ['VALUE', 470.5, 554, 23.7, 7], ['VAT', 527.6, 554, 14, 7],
      ['AGSML009', 43.2, 532.4, 41.3, 8], ['JEWSON Limestone 20mm ......................................', 94.3, 532.4, 225.9, 8],
      ['6.00 EA', 245.1, 523.3, 28.4, 8], ['3.74', 344.4, 523.3, 15.6, 8], ['EA', 421.3, 523.3, 10.7, 8], ['22.44', 491.2, 523.3, 20, 8], ['S', 541.9, 523.3, 5.3, 8],
      ['RAP00503', 43.2, 505, 38.7, 8], ['RAPTOR Flexi Tub 75.0L Blue', 94.3, 505, 108.8, 8],
      ['1.00 EA', 245.1, 495.9, 28.4, 8], ['15.74', 340, 495.9, 20, 8], ['EA', 421.3, 495.9, 10.7, 8], ['15.74', 491.2, 495.9, 20, 8], ['S', 541.9, 495.9, 5.3, 8],
    ]));
    assert.deepEqual(brief(lines), [
      ['JEWSON Limestone 20mm', 6, 3.74, 22.44, 20],
      ['RAPTOR Flexi Tub 75.0L Blue', 1, 15.74, 15.74, 20],
    ]);
    assert.deepEqual(lines.map((l) => l.code), ['AGSML009', 'RAP00503']);
  });

  it('Travis Perkins: a word per item, descriptions carrying on below', () => {
    const lines = findLines(page([
      ['Line', 27.2, 480.2, 22, 9.1], ['Quantity', 61.2, 480.2, 43.4, 9.1], ['Product', 121.8, 480.2, 38.2, 9.1], ['Price', 387.7, 480.2, 27.1, 9.1], ['Total', 515.1, 480.2, 27.1, 9.1], ['V', 554.5, 480.2, 6, 9.1],
      ['1', 80.3, 448.4, 5, 9.1], ['EA', 91, 448.4, 10.4, 9.1], ['General', 118.8, 448.4, 38.5, 9.1], ['Purpose', 163, 448.4, 38.4, 9.1], ['Black', 207.8, 448.4, 26.8, 9.1], ['Bucket', 240.4, 448.4, 33, 9.1], ['PVC', 279.8, 448.4, 16.1, 9.1],
      ['3.33', 379, 448.4, 21.4, 9.1], ['EA', 406.8, 448.4, 10.7, 9.1], ['3.33', 523, 448.4, 21.4, 9.1], ['S', 556.4, 448.4, 5, 9.1],
      ['14ltr', 118.8, 438.8, 27.7, 9.1], ['/', 152.3, 438.8, 5, 9.1], ['3', 163, 438.8, 5, 9.1], ['gallon', 173.8, 438.8, 33.3, 9.1],
      ['40007198', 118.8, 429.1, 43.8, 9.1],
      ['1', 80.3, 409.9, 5, 9.1], ['EA', 91, 409.9, 10.4, 9.1], ['600MM', 118.8, 409.9, 27.7, 9.1], ['24"', 152.3, 409.9, 15.7, 9.1], ['PROSOLVE', 173.8, 409.9, 44.7, 9.1], ['SQUEEGEE', 224.3, 409.9, 43.5, 9.1], ['W/', 274.1, 409.9, 10.7, 9.1],
      ['11.80', 373.6, 409.9, 26.8, 9.1], ['EA', 406.8, 409.9, 10.7, 9.1], ['11.80', 517.6, 409.9, 26.8, 9.1], ['S', 556.4, 409.9, 5, 9.1],
      ['HANDLE', 118.8, 400.3, 33.1, 9.1], ['40006082', 118.8, 390.6, 43.8, 9.1],
    ]));
    assert.deepEqual(brief(lines), [
      ['General Purpose Black Bucket PVC 14ltr / 3 gallon 40007198', 1, 3.33, 3.33, 20],
      ['600MM 24" PROSOLVE SQUEEGEE W/ HANDLE 40006082', 1, 11.8, 11.8, 20],
    ]);
  });

  it('headings set close together stay separate ("Quantity" "Description"), "Unit" "Price" joins', () => {
    const lines = findLines(page([
      ['Quantity', 38.2, 527.8, 43.5, 10], ['Description', 89.4, 527.8, 57.3, 10], ['Unit', 310.4, 527.8, 20.9, 10], ['Price', 334.2, 527.8, 25.1, 10], ['Disc', 369, 527.8, 21, 10], ['Amt', 392.9, 527.8, 20.5, 10],
      ['Net', 431.7, 527.8, 17.8, 10], ['Amt', 452.4, 527.8, 20.5, 10], ['VAT', 482, 527.8, 19.7, 10], ['%', 504.7, 527.8, 12, 10], ['VAT', 540.4, 527.8, 19.7, 10],
      ['21.00', 56.7, 506.5, 24.8, 10], ['3.6m', 89.4, 506.5, 22.3, 10], ['4x2', 114.9, 506.5, 15.9, 10], ['7.45', 340.4, 506.5, 19.4, 10], ['0.00', 394.2, 506.5, 19.4, 10], ['156.45', 442.5, 506.5, 30.3, 10], ['20.00', 482.8, 506.5, 24.8, 10], ['31.29', 536.8, 506.5, 24.8, 10],
      ['150.00', 51.2, 490.4, 30.3, 10], ['1.8m', 89.4, 490.4, 22.3, 10], ['feather', 114.9, 490.4, 31.5, 10], ['edge', 149.4, 490.4, 21.6, 10], ['1.20', 340.2, 490.4, 19.4, 10], ['0.00', 394.2, 490.4, 19.4, 10], ['180.00', 442.5, 490.4, 30.3, 10], ['20.00', 482.8, 490.4, 24.8, 10], ['36.00', 536.8, 490.4, 24.8, 10],
      ['del', 89.4, 474.3, 13.1, 10], ['note', 105.6, 474.3, 19.6, 10], ['7205', 128.3, 474.3, 21.8, 10],
    ]));
    assert.deepEqual(brief(lines), [
      ['3.6m 4x2', 21, 7.45, 156.45, 20],
      ['1.8m feather edge del note 7205', 150, 1.2, 180, 20],
    ]);
  });

  it('Screwfix: a heading over three rows, net taken from "Net", not the gross "Sub Total"', () => {
    const lines = findLines(page([
      ['Product', 29.4, 566, 22.7, 6], ['Description', 126.4, 566, 33, 6], ['Qty', 237.5, 566, 10, 6], ['Unit', 270.7, 569, 11.7, 6], ['Price', 269.2, 563, 14.7, 6],
      ['Sub', 312.8, 569, 11.3, 6], ['Total', 311.3, 563, 14.3, 6], ['Discount', 344.9, 569, 25.7, 6], ['%', 355.1, 563, 5.3, 6], ['Discount', 384.2, 569, 25.7, 6], ['Value', 389.1, 563, 16, 6],
      ['Gross', 430.3, 566, 17.3, 6], ['Net', 476.1, 566, 9.7, 6], ['VAT', 516.8, 569, 12, 6], ['Applied', 511.8, 563, 22, 6], ['VAT', 550.9, 569, 12, 6], ['%', 554.2, 563, 5.3, 6],
      ['339FY', 31.9, 553, 17.7, 6], ['FIRECHIEF 1KG ABC EXTINGUISHER RED PS1X', 59.4, 553, 137.4, 6], ['1', 240.8, 553, 3.3, 6], ['23.99', 279.5, 553, 15, 6], ['23.99', 321.4, 553, 15, 6],
      ['0.00', 361.4, 553, 11.7, 6], ['0.00', 403.4, 553, 11.7, 6], ['23.99', 441.9, 553, 15, 6], ['19.99', 483.9, 553, 15, 6], ['4.00', 529.1, 553, 11.7, 6], ['20.0', 555.3, 553, 11.7, 6],
      ['Sub total', 263.7, 539, 25.7, 6], ['23.99', 321.4, 539, 15, 6], ['£19.99', 480.5, 539, 18.3, 6],
    ]));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].total, 19.99);
    assert.equal(lines[0].quantity, 1);
    assert.equal(lines[0].price, 23.99);
    assert.equal(lines[0].vatRate, 20);
    assert.match(lines[0].description, /FIRECHIEF 1KG ABC EXTINGUISHER/);
  });

  it('two tables (labour, then parts) and a two-column heading', () => {
    const lines = findLines(page([
      ['Labour', 30.8, 539.2, 33.9, 10], ['Amount GBP', 505.9, 539.2, 62.2, 10],
      ['Carry out major service and VHC', 30.8, 520.8, 146.7, 10], ['170.00', 537.5, 520.8, 30.6, 10],
      ['Brake Fluid Change', 30.8, 505.1, 88.4, 10], ['44.00', 543, 505.1, 25, 10],
      ['Sub Total', 352.8, 489.4, 45.6, 10], ['214.00', 537.5, 489.4, 30.6, 10],
      ['Parts', 31, 472, 25, 10], ['Quantity', 358, 472, 40, 10], ['Unit Price', 412, 472, 45, 10], ['Amount GBP', 506, 472, 62, 10],
      ['Oil filter', 31, 454, 40, 10], ['1.00', 379, 454, 19, 10], ['11.00', 434, 454, 25, 10], ['11.00', 543, 454, 25, 10],
      ['Sump plug', 31, 438, 45, 10], ['1.00', 379, 438, 19, 10], ['4.50', 439, 438, 20, 10], ['4.50', 549, 438, 20, 10],
      ['Sub Total', 353, 344, 45, 10], ['228.33', 537, 344, 30, 10],
    ]));
    assert.deepEqual(brief(lines), [
      ['Carry out major service and VHC', null, null, 170, null],
      ['Brake Fluid Change', null, null, 44, null],
      ['Oil filter', 1, 11, 11, null],
      ['Sump plug', 1, 4.5, 4.5, null],
    ]);
  });

  it('a hire invoice: Date From / Date To / Description / Value, a section title in between', () => {
    const lines = findLines(page([
      ['Date From', 33.9, 508, 38.6, 7.8], ['Description', 140.4, 508, 42.9, 7.8], ['Value', 546.2, 507.8, 20.4, 7.8], ['Date To', 95.4, 508, 28, 7.8],
      ['18/09/2026', 33, 492.7, 40.5, 8.1], ['GENERATOR 2.7KVA (GEN514). £40.00 per week for 1 week, 4 days (hire complete)', 139.5, 492.7, 308.8, 8.1], ['£80.00', 542.8, 492.7, 24.8, 8.1], ['28/09/2026', 89.1, 492.7, 40.5, 8.1],
      ['Sale Items', 25.9, 476, 38.3, 8.1],
      ['28/09/2026', 33, 462.4, 40.5, 8.1], ['PETROL (TANK). 0.5 @ £12.00', 139.4, 462.4, 114, 8.1], ['£6.00', 547.3, 462.4, 20.3, 8.1],
    ]));
    assert.deepEqual(lines.map((l) => [l.description, l.total]), [
      ['GENERATOR 2.7KVA (GEN514). £40.00 per week for 1 week, 4 days (hire complete)', 80],
      ['PETROL (TANK). 0.5 @ £12.00', 6],
    ]);
  });

  it('a VAT summary table is not a line table', () => {
    const lines = findLines(page([
      ['Vat code', 38, 209, 42, 10], ['Vat rate', 92, 210, 37, 10], ['Value', 155, 210, 27, 10], ['Vat', 218, 210, 15, 10],
      ['S', 41, 189, 7, 10], ['20 %', 92, 189, 23, 10], ['£37.85', 156, 189, 30, 10], ['£7.57', 223, 189, 25, 10],
    ]));
    assert.deepEqual(lines, []);
  });

  it('lines with no rate take the invoice rate when VAT ÷ goods is a standard rate', () => {
    const lines = [{ total: 170, vatRate: null }, { total: 44, vatRate: 0 }];
    assert.deepEqual(fillMissingRates(lines, 442.33, 88.47).map((l) => [l.vatRate, l.vatRateFrom]), [[20, 'totals'], [0, undefined]]);
    assert.equal(fillMissingRates(lines, 100, 13)[0].vatRate, null); // 13% is not a standard rate
  });
});

describe('payment terms', () => {
  const at = (str) => page([[str, 40, 42, 300, 8]]);
  it('works out the due date from the invoice date', () => {
    assert.equal(findPaymentTerms(at('TERMS STRICTLY 30 DAYS NET.'), '2026-08-07').dueDate, '2026-09-06');
    assert.equal(findPaymentTerms(at('Payment terms: net 14'), '2026-09-28').dueDate, '2026-10-12');
    assert.equal(findPaymentTerms(at('30 days end of month'), '2026-09-15').dueDate, '2026-10-30');
    assert.equal(findPaymentTerms(at('Payment due end of month following'), '2026-09-15').dueDate, '2026-10-31');
    assert.equal(findPaymentTerms(at('Payment is due within 7 days'), '2026-10-01').days, 7);
  });
  it('ignores returns and complaints wording', () => {
    assert.equal(findPaymentTerms(at('please call or email online@screwfix.com within 28 days to arrange collection.')), null);
    assert.equal(findPaymentTerms(at('All queries must be notified within 7 days.')), null);
  });
});

describe('VAT numbers', () => {
  it('finds them however they are spaced, and skips an EORI number', () => {
    const found = findVatNumbers(page([
      ['Vat No.', 385, 674, 33, 10], ['GB 162 395 011', 484, 673, 73, 10],
      ['VAT Reg. No. GB 394 1212 63', 453, 64, 120, 8],
      ['IF PAYING BY BACS PLEASE PAY: VAT Reg. No: GB222828472', 46, 160, 400, 8],
      ['Cemex UK Operations Ltd, SORT CODE EORI No: GB222828472241', 46, 100, 400, 8],
    ]));
    assert.deepEqual(found.map((f) => f.number), ['162395011', '222828472', '394121263']);
  });
  it('normalises', () => {
    assert.equal(normaliseVatNumber('GB 162 395 011'), '162395011');
    assert.equal(normaliseVatNumber('12345'), null);
  });
  it('parses cell numbers', () => {
    assert.deepEqual(['6.00 EA', '£1,234.50', '20%', 'S', '-3'].map(parseNumber), [6, 1234.5, 20, null, -3]);
  });
});
