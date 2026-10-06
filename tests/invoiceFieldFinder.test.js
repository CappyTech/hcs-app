import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import finder from '../public/js/invoice-field-finder.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const { toItems, findFields, findCandidates, locateValue, parseDate, parseMoney, parseReference } = finder;

// PDF.js-shaped text item: [x, y, width, str], height 10
const item = ([x, y, w, str], h = 10) => ({ str, transform: [h, 0, 0, h, x, y], width: w, height: h });
const page = (rows, n = 1) => toItems(rows.map((r) => item(r)), n);

// Paperless document 1110 (Duttons Builders Merchants), positions as PDF.js reports them
const DUTTONS = page([
  [36, 813, 139, 'Duttons Builders Merchants Ltd'],
  [229, 705, 99, 'INVOICE'],
  [385, 674, 33, 'Vat No.'], [484, 673, 73, 'GB 162 395 011'],
  [385, 661, 59, 'Sales Person'], [531, 660, 26, 'IANW'],
  [385, 649, 64, 'Document No.'], [524, 647, 33, '260461'],
  [385, 636, 21, 'Date'], [508, 635, 50, '28/09/2026'],
  [385, 623, 44, 'Order No.'], [513, 622, 44, 'WARREN'],
  [385, 609, 54, 'Account No.'], [520, 608, 38, 'HER003'],
  [39, 559, 36, 'Part No.'], [137, 559, 50, 'Description'], [360, 559, 23, 'Price'], [417, 559, 15, 'Qty'], [466, 559, 29, 'Goods'], [539, 558, 19, 'VAT'],
  [36, 544, 48, 'MJIADB20'], [137, 543, 54, 'Ad Blue 20L'], [356, 542, 30, '£25.00'], [413, 542, 19, '1.00'], [465, 543, 30, '£25.00'], [533, 543, 25, '£5.00'],
  [36, 229, 74, 'VAT SUMMARY'],
  [38, 209, 42, 'Vat code'], [92, 210, 37, 'Vat rate'], [155, 210, 27, 'Value'], [218, 210, 15, 'Vat'],
  [360, 208, 54, 'Total Goods'], [513, 208, 30, '£37.85'],
  [41, 189, 7, 'S'], [92, 189, 23, '20 %'], [156, 189, 30, '£37.85'], [223, 189, 25, '£7.57'],
  [360, 188, 44, 'Total VAT'], [519, 188, 25, '£7.57'],
  [360, 159, 46, 'Total Due'], [513, 159, 30, '£45.42'],
  [32, 84, 131, 'Charged to Account: £45.42'],
]);

describe('invoice field finder', () => {
  it('reads document 1110', () => {
    const f = findFields(DUTTONS);
    assert.equal(f.invoiceNumber.value, '260461');
    assert.equal(f.invoiceDate.value, '2026-09-28');
    assert.equal(f.dueDate, null);
    assert.equal(f.totalGoods.value, '37.85');
    assert.equal(f.totalVat.value, '7.57');
    assert.equal(f.invoiceTotal.value, '45.42');
  });

  it('boxes the value text, not the label', () => {
    const { invoiceNumber, invoiceTotal } = findFields(DUTTONS);
    assert.deepEqual([invoiceNumber.page, Math.round(invoiceNumber.box.x), Math.round(invoiceNumber.box.w)], [1, 524, 33]);
    assert.ok(invoiceNumber.box.y < 647 && invoiceNumber.box.y + invoiceNumber.box.h > 647 + 5);
    assert.equal(Math.round(invoiceTotal.box.x), 513);
    assert.equal(Math.round(invoiceNumber.labelBox.x), 385);
  });

  it('a value inside the label item gets a box over just that part', () => {
    const items = page([[40, 700, 150, 'Invoice No: INV-0042']]);
    const f = findFields(items);
    assert.equal(f.invoiceNumber.value, 'INV-0042');
    assert.ok(f.invoiceNumber.box.x > 100 && Math.round(f.invoiceNumber.box.x + f.invoiceNumber.box.w) === 190);
  });

  it('labels split over items, values under headers, and a due date', () => {
    const items = page([
      [40, 700, 30, 'Invoice'], [72, 700, 15, 'No.'], [200, 700, 60, 'Invoice Date'], [300, 700, 50, 'Due Date'],
      [40, 686, 40, 'A1234'], [200, 686, 50, '3 Oct 2026'], [300, 686, 50, '02/11/2026'],
    ]);
    const f = findFields(items);
    assert.equal(f.invoiceNumber.value, 'A1234');
    assert.equal(f.invoiceDate.value, '2026-10-03');
    assert.equal(f.dueDate.value, '2026-11-02');
  });

  it('prefers totals that add up over a better-ranked label that does not', () => {
    const items = page([
      [300, 300, 40, 'Subtotal'], [450, 300, 40, '100.00'],
      [300, 280, 40, 'VAT @ 20%'], [450, 280, 40, '20.00'],
      [300, 260, 40, 'Total'], [450, 260, 40, '120.00'],
      [300, 240, 40, 'Amount due'], [450, 240, 40, '0.00'],
    ]);
    const c = findCandidates(items);
    assert.equal(c.invoiceTotal[0].value, '0.00'); // "Amount due" outranks "Total"…
    assert.equal(findFields(items).invoiceTotal.value, '120.00'); // …but 100 + 20 = 120
  });

  it('does not take a table column header as a total', () => {
    const items = page([[400, 500, 30, 'Total'], [400, 486, 30, '12.50']]);
    assert.equal(findFields(items).invoiceTotal, null);
  });

  it('stops at the next label on the row', () => {
    const items = page([[40, 700, 60, 'Invoice No.'], [110, 700, 40, 'Date'], [160, 700, 50, '01/02/2026']]);
    assert.equal(findFields(items).invoiceNumber, null);
  });

  it('a label wrapped onto two lines (Cemex, one OCR word per item)', () => {
    const items = page([
      [369, 772, 36, 'Sales'], [409, 772, 34, 'Invoice'],
      [369, 750, 20, 'No:'], [396, 750, 52, '3015645870'], [515, 744, 20, 'Page'],
      [292, 718, 34, 'Account'], [330, 718, 15, 'No:'], [369, 718, 36, 'Payment'],
      [292, 704, 52, '0050533837'], [369, 704, 30, 'CEMEX'],
      [292, 671, 15, 'Tax'], [310, 671, 22, 'Point'], [335, 671, 25, 'Date:'], [369, 671, 90, 'STOCKTON-ON-TEES'],
      [292, 658, 48, '07.09.2026'], [369, 658, 20, 'TS17'],
    ]);
    const f = findFields(items);
    assert.equal(f.invoiceNumber.value, '3015645870');
    assert.equal(Math.round(f.invoiceNumber.box.x), 396);
    assert.equal(Math.round(f.invoiceNumber.labelBox.x), 369);
    assert.equal(f.invoiceDate.value, '2026-09-07');
  });

  it('a one-line label is not glued to the line below', () => {
    const items = page([[40, 700, 40, 'Invoice'], [40, 688, 40, 'No: 999']]);
    // "Invoice" alone has nothing beside it; joining it to "No: 999" is the wrap case,
    // so this does find 999, but only through the wrapped (lower-scored) route
    const c = findCandidates(items).invoiceNumber;
    assert.equal(c[0].value, '999');
    assert.ok(c[0].score >= 2);
  });

  it('totals in a Gross / Net / VAT table (Screwfix)', () => {
    const items = page([
      [430, 566, 25, 'Gross'], [476, 566, 18, 'Net'], [517, 569, 18, 'VAT'], [551, 569, 18, 'VAT'],
      [384, 569, 40, 'Discount'], [389, 563, 25, 'Value'], [512, 563, 32, 'Applied'], [554, 563, 8, '%'],
      [264, 539, 40, 'Sub total'], [321, 539, 25, '23.99'], [403, 539, 20, '0.00'], [439, 539, 30, '£23.99'], [481, 539, 30, '£19.99'], [526, 539, 25, '£4.00'],
      [399, 518, 40, 'Total Paid:'], [521, 518, 30, '£23.99'],
    ]);
    const f = findFields(items);
    assert.equal(f.totalGoods.value, '19.99');
    assert.equal(f.totalVat.value, '4.00');
    assert.equal(f.invoiceTotal.value, '23.99');
    assert.equal(Math.round(f.totalVat.box.x), 526);
  });

  it('Stark: "INV TOTAL £", and bare Total does not take TOTAL GOODS', () => {
    const items = page([
      [374, 140, 60, 'TOTAL GOODS'], [493, 140, 25, '38.18'],
      [374, 128, 50, 'TOTAL VAT'], [499, 128, 20, '7.64'],
      [374, 91, 60, 'INV TOTAL £'], [493, 91, 25, '45.82'],
    ]);
    const f = findFields(items);
    assert.deepEqual([f.totalGoods.value, f.totalVat.value, f.invoiceTotal.value], ['38.18', '7.64', '45.82']);
  });

  it('a hire invoice: "Total Charge", "VAT @ 20.0 %", "TOTAL:"', () => {
    const items = page([
      [443, 396, 50, 'Total Charge:'], [542, 396, 35, '£186.25'],
      [439, 381, 50, 'VAT @ 20.0 %'], [547, 381, 30, '£37.25'],
      [464, 366, 30, 'TOTAL:'], [544, 366, 35, '£223.50'],
    ]);
    const f = findFields(items);
    assert.deepEqual([f.totalGoods.value, f.totalVat.value, f.invoiceTotal.value], ['186.25', '37.25', '223.50']);
  });

  it('a column heading is not glued to a label further along the row (1137)', () => {
    const items = page([
      [32, 475, 30, 'VAT Rate'], [276, 475, 15, 'Net'], [330, 475, 15, 'VAT'], [413, 473, 40, 'Total Net'], [532, 473, 25, '550.00'],
      [32, 460, 80, 'Exempt 0.00% (0.00%)'], [258, 460, 35, '£550.00'], [325, 460, 25, '£0.00'], [409, 460, 40, 'Total VAT'], [542, 460, 15, '0.00'],
      [419, 447, 25, 'TOTAL'], [527, 447, 35, '£550.00'],
    ]);
    const f = findFields(items);
    assert.deepEqual([f.totalGoods.value, f.totalVat.value, f.invoiceTotal.value], ['550.00', '0.00', '550.00']);
  });

  it('"Tax Amount" and "Total (excluding Tax)" (1133)', () => {
    const items = [
      ...page([
        [38, 486, 500, 'This invoice is for any subscription purchases, renewals, and recurring charges on the date indicated. Tax'],
        [47, 407, 40, 'Subtotal'], [546, 407, 25, '10.29'],
        [47, 364, 90, 'Total (including Tax)'], [520, 364, 50, 'GBP 12.35'],
      ], 1),
      ...page([
        [44, 389, 90, 'Total (excluding Tax)'], [550, 389, 25, '10.29'],
        [44, 368, 50, 'Tax Amount'], [553, 368, 20, '2.06'],
      ], 2),
    ];
    const f = findFields(items);
    assert.deepEqual([f.totalGoods.value, f.totalVat.value, f.invoiceTotal.value], ['10.29', '2.06', '12.35']);
  });

  it('Xero header row: values under headings, a split invoice number, "Sept" (1140)', () => {
    const items = toItems([
      item([30, 593, 51, 'Amount due'], 9), item([105, 593, 38, 'Due date'], 9), item([207, 593, 43, 'Issue date'], 9),
      item([297, 593, 64, 'Invoice number'], 9), item([385, 593, 43, 'Reference'], 9),
      item([30, 575, 47, '£59.84'], 13), item([105, 575, 78, '21 Oct 2026'], 13), item([207, 575, 66, '21 Sept 2026'], 10),
      item([297.02, 575, 18.55, 'INV'], 10), item([314.98, 575, 4.86, '\uE088'], 10), item([319.61, 575, 28.47, '22121'], 10),
      item([385, 575, 48, 'MICHAEL'], 10),
    ], 1);
    const f = findFields(items);
    assert.equal(f.invoiceNumber.value, 'INV-22121');
    assert.equal(Math.round(f.invoiceNumber.box.x), 297);
    assert.equal(Math.round(f.invoiceNumber.box.x + f.invoiceNumber.box.w), 348);
    assert.equal(f.invoiceDate.value, '2026-09-21');
    assert.equal(f.dueDate.value, '2026-10-21');
  });

  it('looking below a label stays on its own page', () => {
    const items = [
      ...page([[227, 614, 57, 'Invoice Date'], [227, 600, 55, '01 Sep 2026'], [227, 573, 73, 'Invoice Number'], [227, 560, 42, 'INV-2914']], 1),
      ...page([[224, 614, 30, 'Date'], [224, 561, 42, 'INV-2914']], 2),
    ];
    const f = findFields(items);
    assert.equal(f.invoiceDate.value, '2026-09-01');
    assert.equal(f.invoiceNumber.value, 'INV-2914');
    assert.equal(f.invoiceNumber.page, 1);
  });

  it('locates a value that was already filled in', () => {
    assert.equal(Math.round(locateValue(DUTTONS, 'invoiceTotal', 45.42).box.x), 513);
    assert.equal(Math.round(locateValue(DUTTONS, 'invoiceNumber', '260461').box.x), 524);
    assert.equal(locateValue(DUTTONS, 'invoiceDate', '2026-09-28').page, 1);
    assert.equal(locateValue(DUTTONS, 'invoiceNumber', 'NOPE1'), null);
  });

  it('parsers', () => {
    assert.equal(parseDate('28/09/2026'), '2026-09-28');
    assert.equal(parseDate('1st September 26'), '2026-09-01');
    assert.equal(parseDate('31/02/2026'), null);
    assert.equal(parseMoney('£1,234.50'), '1234.50');
    assert.equal(parseMoney('(12.00)'), '-12.00');
    assert.equal(parseMoney('3.00') , '3.00');
    assert.equal(parseMoney('3'), null);
    assert.equal(parseReference('#INV/22-01.'), 'INV/22-01');
    assert.equal(parseReference('GB 162 395 011'), null);
    assert.equal(parseReference('WARREN'), null);
  });
});

describe('entry screen wiring', () => {
  const view = read('mongoose/views/tailwindcss/paperless/entry.ejs');

  it('every invoice field the finder fills has an input and a hint', () => {
    for (const { field } of finder.FIELDS) {
      // [^\n], not [^>]: the EJS value="<%= … %>" has a > in it
      assert.match(view, new RegExp(`name="${field}"[^\\n]*data-suggest-field="${field}"`), field);
      assert.ok(view.includes(`<p data-suggest-for="${field}" hidden></p>`), field);
    }
  });

  it('the suggestions script loads before the viewer, so it hears the viewer events', () => {
    const s = view.indexOf('/resources/js/document-suggestions.js');
    const v = view.indexOf('/resources/js/document-viewer.js');
    assert.ok(s > 0 && s < v);
  });

  it('the viewer fires the events the suggestions listen for', () => {
    const viewer = read('public/js/document-viewer.js');
    const sugg = read('public/js/document-suggestions.js');
    for (const ev of ['hcs:pdf-loaded', 'hcs:pdf-page']) {
      assert.ok(viewer.includes(`new CustomEvent('${ev}'`), ev);
      assert.ok(sugg.includes(`addEventListener('${ev}'`), ev);
    }
    assert.match(sugg, /from '\/resources\/js\/invoice-field-finder\.js'/);
  });

  it('document text reaches the page only as text, never as HTML', () => {
    const sugg = read('public/js/document-suggestions.js');
    for (const m of sugg.matchAll(/innerHTML = ([^;]+);/g)) assert.match(m[1], /^'<i class="bi bi-[a-z0-9-]+"><\/i> '$/, m[0]);
  });
});

describe('exact boxes', () => {
  const { fitBox } = finder;
  // "Invoice No. A26825510698" in a font where capitals and digits are wide and spaces narrow
  const str = 'Invoice No. A26825510698';
  const widths = { ' ': 3, '.': 3, i: 3, o: 6, c: 6, e: 6, v: 6, n: 6, I: 4, N: 10, A: 10 };
  const measure = (t) => [...t].reduce((s, ch) => s + (widths[ch] ?? 8), 0);
  const item = toItems([{ str, transform: [24, 0, 0, 24, 300, 700], width: measure(str) * 2, height: 24 }], 1)[0];

  it('places a box around part of an item by the real character widths', () => {
    const f = findFields([item]);
    const naive = f.invoiceNumber.box;
    assert.equal(f.invoiceNumber.value, 'A26825510698');
    const exact = fitBox(naive, measure);
    // 'Invoice No. ' is 62 units of 160, drawn 320 wide → x = 300 + 320 × 62/160 = 424
    assert.equal(Math.round(exact.x), 424);
    assert.equal(Math.round(exact.x + exact.w), 300 + 320);
    assert.ok(naive.x > exact.x + 5, 'the equal-width guess starts too far right and cuts off the "A"');
  });

  it('leaves a whole-item box, and a box with no way to measure, as it was', () => {
    const whole = finder.charBox(item);
    assert.equal(fitBox(whole, measure), whole);
    const part = finder.charBox(item, 12);
    assert.equal(fitBox(part, null), part);
    assert.equal(fitBox(part, () => 0), part);
  });
});

describe('learned supplier layouts', () => {
  // Two "Total"-ish figures and no label the finder knows for the invoice number
  const items = toItems([
    item([40, 700, 60, 'Our ref']), item([120, 700, 40, 'X-77812']),
    item([300, 300, 40, 'Total']), item([450, 300, 40, '120.00']),
    item([300, 280, 40, 'Total']), item([450, 280, 40, '99.00']),
  ], 1);

  it('without a layout, an unlabelled number is not guessed and the first Total wins', () => {
    const f = findFields(items);
    assert.equal(f.invoiceNumber, null);
    assert.equal(f.invoiceTotal.value, '120.00');
  });

  it('a learned spot picks the value printed there, and promotes the candidate there', () => {
    const layout = {
      invoiceNumber: { page: 1, x: 120, y: 697.5, w: 40, h: 12.5 },
      invoiceTotal: { page: 1, x: 450, y: 277.5, w: 40, h: 12.5 },
    };
    const f = findFields(items, { layout });
    assert.equal(f.invoiceNumber.value, 'X-77812');
    assert.equal(f.invoiceNumber.learned, true);
    assert.equal(f.invoiceTotal.value, '99.00');
  });

  it('a spot on another page counts for nothing', () => {
    const f = findFields(items, { layout: { invoiceNumber: { page: 2, x: 120, y: 697.5, w: 40, h: 12.5 } } });
    assert.equal(f.invoiceNumber, null);
  });
});
