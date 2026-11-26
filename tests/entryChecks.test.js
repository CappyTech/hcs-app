import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liveChecks, netLines, pickValue, parseVatRate, sameLines, VAT_RATES } from '../public/js/entry-checks.js';

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

  it('says when the line totals include VAT, instead of two mismatches', () => {
    const lines = [
      { description: 'a', quantity: '1', price: '', total: '7.48', vatRate: '20' },
      { description: 'b', quantity: '1', price: '', total: '10.49', vatRate: '20' },
    ];
    assert.deepEqual(liveChecks({ totalGoods: '14.97', totalVat: '3', invoiceTotal: '17.97' }, lines), [
      'Lines add up to £17.97, which is goods + VAT: the line totals include VAT. Use “Take VAT off the lines” to make each line net, so they add up to total goods £14.97.',
    ]);
  });

  it('makes VAT-inclusive lines net for the Take VAT off button', () => {
    const lines = [
      { description: 'Item one', quantity: '1', price: '7.48', total: '7.48', vatRate: '20' },
      { description: '', quantity: '', price: '', total: '', vatRate: '' },
      { description: 'Item two', quantity: '1', price: '10.49', total: '10.49', vatRate: '' },
      { description: 'Item three', quantity: '1', price: '0', total: '0.00', vatRate: '20' },
    ];
    const net = netLines({ totalGoods: '14.97', totalVat: '3.00' }, lines);
    assert.equal(net[1], null);
    assert.deepEqual(net.filter(Boolean).map((l) => l.total), ['6.23', '8.74', '0.00']);
    assert.equal(net[2].vatRate, '20'); // a blank rate is filled from the totals
    assert.equal(net[2].price, '8.74');
    assert.equal(net.filter(Boolean).reduce((s, l) => s + Number(l.total), 0).toFixed(2), '14.97');
  });

  it('offers no Take VAT off when the lines are already net or can’t be worked out', () => {
    const header = { totalGoods: '14.97', totalVat: '3.00' };
    assert.equal(netLines(header, [{ description: 'a', quantity: '1', price: '', total: '14.97', vatRate: '20' }]), null);
    assert.equal(netLines(header, [{ description: 'a', quantity: '', price: '', total: '', vatRate: '20' }]), null);
    assert.equal(netLines({ totalGoods: '17.97', totalVat: '0' }, [{ description: 'a', quantity: '1', price: '', total: '17.97', vatRate: '0' }]), null);
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
    assert.equal(pickValue('invoiceDate', 'November 11, 2026', 'November'), '2026-11-11');
    assert.equal(pickValue('dueDate', 'Due on December 11, 2026 please', 'December'), '2026-12-11');
    // A date in a phrase, clicked on any word of it
    assert.equal(pickValue('dueDate', 'Payment due by 12 March 2026', 'March'), '2026-03-12');
    assert.equal(pickValue('dueDate', 'Due on 05/04/2026', 'on'), '2026-04-05');
    assert.equal(pickValue('dueDate', 'Payment due by end of month', 'month'), null);
    assert.equal(pickValue('invoiceTotal', 'Payment due by 12 March 2026', '12'), '12.00', 'only dates look inside the phrase');
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
    for (const hook of ['data-lines', 'data-line="<%= i %>"', 'data-line-label', 'id="suggest-fill-lines"', 'data-suggest-checks', 'data-suggest-disagree', 'id="pdf-pick-status"', 'data-values-source=', 'data-clear-entry', 'data-remove-line']) {
      assert.ok(view.includes(hook), hook);
    }
  });
  it('the UI module imports only the pure helpers it needs', () => {
    const sugg = read('public/js/document-suggestions.js');
    assert.match(sugg, /from '\/resources\/js\/invoice-line-finder\.js'/);
    assert.match(sugg, /from '\/resources\/js\/entry-checks\.js'/);
    assert.ok(!/innerHTML/.test(sugg), 'builds DOM with textContent only');
  });
  it('each line has a plain remove button that document-suggestions.js takes the line off with', () => {
    assert.equal((view.match(/<button type="button" data-remove-line aria-label="Remove line <%= i \+ 1 %>"/g) || []).length, 2, 'both line layouts (subcontractor or not)');
    const sugg = read('public/js/document-suggestions.js');
    assert.match(sugg, /closest\('\[data-remove-line\]'\)/);
    assert.match(sugg, /function renumberLines\(\)/);
  });
  it('Clear entry is a plain button (no submit) that document-suggestions.js empties the boxes from', () => {
    assert.match(view, /<button type="button" data-clear-entry/);
    const sugg = read('public/js/document-suggestions.js');
    assert.match(sugg, /\[data-clear-entry\]/);
  });
});
