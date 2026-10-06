import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liveChecks, pickValue, parseVatRate, sameLines, VAT_RATES } from '../public/js/entry-checks.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('live checks on the entry form', () => {
  const stark = [
    { description: 'JEWSON Limestone 20mm', quantity: '6', price: '3.74', total: '22.44', vatRate: '20' },
    { description: 'RAPTOR Flexi Tub', quantity: '1', price: '15.74', total: '15.74', vatRate: '20' },
    { description: '', quantity: '', price: '', total: '', vatRate: '' },
  ];

  it('is quiet when lines, VAT and totals agree', () => {
    assert.deepEqual(liveChecks({ totalGoods: '38.18', totalVat: '7.64', invoiceTotal: '45.82' }, stark), []);
  });

  it('flags lines that miss total goods, VAT that misses the line rates, and totals that miss', () => {
    const out = liveChecks({ totalGoods: '38.00', totalVat: '6.00', invoiceTotal: '45.82' }, stark);
    assert.deepEqual(out, [
      'Lines add up to £38.18, but total goods is £38.00.',
      'VAT at the line rates comes to £7.64, but total VAT is £6.00.',
      'Goods £38.00 + VAT £6.00 is £44.00, not the invoice total £45.82.',
    ]);
  });

  it('works a line total out from qty × price, and skips the VAT check when a rate is missing', () => {
    const lines = [{ description: 'x', quantity: '3', price: '4.28', total: '', vatRate: '' }];
    assert.deepEqual(liveChecks({ totalGoods: '12.84', totalVat: '9.99' }, lines), []);
  });

  it('VAT % is a percentage: a VAT amount typed into it is flagged, not counted as a rate', () => {
    const lines = [
      { ...stark[0], vatRate: '4.49' }, // the VAT on 22.44, not the rate
      { ...stark[1], vatRate: '20%' },
    ];
    assert.deepEqual(liveChecks({ totalGoods: '38.18', totalVat: '7.64', invoiceTotal: '45.82' }, lines), [
      'Line 1 VAT % is "4.49". VAT % is a percentage (0, 5, 20), not an amount.',
    ]);
  });
});

describe('are the form lines the document lines?', () => {
  const doc = [{ quantity: 1, price: 23.37, total: 23.37, vatRate: 20 }, { quantity: 1, price: 0.7945, total: 0.79, vatRate: 20 }];
  const row = (quantity, price, total, vatRate = '20') => ({ description: 'x', quantity, price, total, vatRate });

  it('yes when every figure matches', () => {
    assert.equal(sameLines([row('1', '23.37', '23.37'), row('1', '0.7945', '0.79')], doc), true);
  });

  it('no when only the totals match (#1120: bricks at the per-thousand price)', () => {
    assert.equal(sameLines([row('1', '23.37', '23.37'), row('1', '794.51', '0.79')], doc), false);
    assert.equal(sameLines([row('1', '23.37', '23.37'), row('1', '0.7945', '0.79', '5')], doc), false);
    assert.equal(sameLines([row('1', '23.37', '23.37')], doc), false);
  });

  it('ignores what the document has no figure for', () => {
    assert.equal(sameLines([row('', '', '23.37', '')], [{ quantity: null, price: null, total: 23.37, vatRate: null }]), true);
  });
});

describe('VAT % on a line', () => {
  it('is one of the UK rates, with or without "%"', () => {
    assert.deepEqual(['20', '20%', ' 5 ', '0', '20.00', ''].map(parseVatRate), [20, 20, 5, 0, 20, null]);
    for (const v of ['4.49', '3', '17.5', '100', '-20', 'S', '£20']) assert.ok(Number.isNaN(parseVatRate(v)), v);
    assert.deepEqual(VAT_RATES, [0, 5, 20]);
  });
});

describe('picking a value off the PDF', () => {
  it('reads what the field needs from the clicked text', () => {
    assert.equal(pickValue('invoiceTotal', '£45.42'), '45.42');
    assert.equal(pickValue('invoiceTotal', 'Charged to Account: £45.42', '£45.42'), '45.42');
    assert.equal(pickValue('invoiceDate', '28/09/2026'), '2026-09-28');
    assert.equal(pickValue('invoiceNumber', 'Invoice No: INV-0042', 'INV-0042'), 'INV-0042');
    assert.equal(pickValue('line.quantity', '6.00 EA'), '6');
    assert.equal(pickValue('line.price', '£4.28'), '4.28');
    assert.equal(pickValue('line.vatRate', '20%'), '20');
    assert.equal(pickValue('line.description', 'JEWSON Limestone 20mm .........  Handy Bag'), 'JEWSON Limestone 20mm Handy Bag');
  });
  it('refuses text that does not fit the field', () => {
    assert.equal(pickValue('invoiceTotal', 'Total Due'), null);
    assert.equal(pickValue('invoiceDate', 'WARREN'), null);
    // Clicking the VAT amount column, not the rate
    assert.equal(pickValue('line.vatRate', '4.49'), null);
    assert.equal(pickValue('line.vatRate', '£3.00'), null);
  });
});

describe('entry screen hooks for lines, checks and picking', () => {
  const view = read('mongoose/views/tailwindcss/paperless/entry.ejs');
  it('has the elements document-suggestions.js looks for', () => {
    for (const hook of ['data-lines', 'data-line="<%= i %>"', 'data-line-label', 'id="suggest-fill-lines"', 'data-suggest-checks', 'data-suggest-disagree', 'id="pdf-pick-status"', 'data-values-source=']) {
      assert.ok(view.includes(hook), hook);
    }
  });
  it('the UI module imports only the pure helpers it needs', () => {
    const sugg = read('public/js/document-suggestions.js');
    assert.match(sugg, /from '\/resources\/js\/invoice-line-finder\.js'/);
    assert.match(sugg, /from '\/resources\/js\/entry-checks\.js'/);
    assert.ok(!/innerHTML/.test(sugg), 'builds DOM with textContent only');
  });
});
