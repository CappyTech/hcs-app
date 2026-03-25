const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoiceAmounts, normalizeWhtRate, whtRateLabel } = require('../services/cisService');

// ── normalizeWhtRate ─────────────────────────────────────────────────────────

describe('normalizeWhtRate', () => {
  it('converts whole-number 20 to 0.2', () => {
    assert.equal(normalizeWhtRate(20), 0.2);
  });

  it('converts whole-number 30 to 0.3', () => {
    assert.equal(normalizeWhtRate(30), 0.3);
  });

  it('preserves decimal 0.2', () => {
    assert.equal(normalizeWhtRate(0.2), 0.2);
  });

  it('preserves decimal 0.3', () => {
    assert.equal(normalizeWhtRate(0.3), 0.3);
  });

  it('preserves 0 (gross)', () => {
    assert.equal(normalizeWhtRate(0), 0);
  });

  it('passes null through', () => {
    assert.equal(normalizeWhtRate(null), null);
  });

  it('passes undefined through', () => {
    assert.equal(normalizeWhtRate(undefined), undefined);
  });

  it('passes -1 through', () => {
    assert.equal(normalizeWhtRate(-1), -1);
  });

  it('passes empty string through', () => {
    assert.equal(normalizeWhtRate(''), '');
  });

  it('converts string "20" to 0.2', () => {
    assert.equal(normalizeWhtRate('20'), 0.2);
  });

  it('converts string "0.3" to 0.3', () => {
    assert.equal(normalizeWhtRate('0.3'), 0.3);
  });

  it('returns null for non-numeric string', () => {
    assert.equal(normalizeWhtRate('abc'), null);
  });
});

// ── whtRateLabel ─────────────────────────────────────────────────────────────

describe('whtRateLabel', () => {
  it('returns "0% (Gross)" for rate 0', () => {
    assert.equal(whtRateLabel(0), '0% (Gross)');
  });

  it('returns "20%" for rate 20 (REST format)', () => {
    assert.equal(whtRateLabel(20), '20%');
  });

  it('returns "20%" for rate 0.2 (SOAP format)', () => {
    assert.equal(whtRateLabel(0.2), '20%');
  });

  it('returns "30%" for rate 30', () => {
    assert.equal(whtRateLabel(30), '30%');
  });

  it('returns "30%" for rate 0.3', () => {
    assert.equal(whtRateLabel(0.3), '30%');
  });

  it('returns null for unrecognised rate', () => {
    assert.equal(whtRateLabel(15), null);
  });

  it('returns null for null input', () => {
    assert.equal(whtRateLabel(null), null);
  });
});

// ── calculateInvoiceAmounts ──────────────────────────────────────────────────

describe('calculateInvoiceAmounts', () => {
  it('calculates 0% CIS (gross payment)', () => {
    const r = calculateInvoiceAmounts(1000, 500, 0);
    assert.equal(r.cisRate, 0);
    assert.equal(r.grossAmount, '1500.00');
    assert.equal(r.cisAmount, '0.00');
    assert.equal(r.netAmount, '1500.00');
  });

  it('calculates 20% CIS deduction (REST format)', () => {
    const r = calculateInvoiceAmounts(1000, 500, 20);
    assert.equal(r.cisRate, 0.2);
    assert.equal(r.grossAmount, '1500.00');
    assert.equal(r.cisAmount, '200.00');   // 1000 * 0.2
    assert.equal(r.netAmount, '1300.00');  // 1500 - 200
  });

  it('calculates 20% CIS deduction (SOAP format)', () => {
    const r = calculateInvoiceAmounts(1000, 500, 0.2);
    assert.equal(r.cisRate, 0.2);
    assert.equal(r.cisAmount, '200.00');
    assert.equal(r.netAmount, '1300.00');
  });

  it('calculates 30% CIS deduction', () => {
    const r = calculateInvoiceAmounts(1000, 500, 30);
    assert.equal(r.cisRate, 0.3);
    assert.equal(r.cisAmount, '300.00');
    assert.equal(r.netAmount, '1200.00');
  });

  it('defaults unrecognised rate to 30%', () => {
    const r = calculateInvoiceAmounts(1000, 0, 99);
    assert.equal(r.cisRate, 0.3);
    assert.equal(r.cisAmount, '300.00');
  });

  it('CIS deduction applies only to labour, not materials', () => {
    const r = calculateInvoiceAmounts(800, 200, 20);
    assert.equal(r.cisAmount, '160.00');   // 800 * 0.2 — materials excluded
    assert.equal(r.grossAmount, '1000.00');
    assert.equal(r.netAmount, '840.00');
  });

  it('computes reverse charge as 20% of labour', () => {
    const r = calculateInvoiceAmounts(500, 100, 0);
    assert.equal(r.reverseCharge, '100.00'); // 500 * 0.2
  });

  it('returns all three CIS amount variants', () => {
    const r = calculateInvoiceAmounts(1000, 0, 20);
    assert.equal(r.cisAmountZero, '0.00');
    assert.equal(r.cisAmountTwo, '200.00');
    assert.equal(r.cisAmountThree, '300.00');
  });

  it('handles string inputs (parseFloat)', () => {
    const r = calculateInvoiceAmounts('1000.50', '499.50', 20);
    assert.equal(r.grossAmount, '1500.00');
    assert.equal(r.cisAmount, '200.10');   // 1000.50 * 0.2
  });

  it('handles zero labour and materials', () => {
    const r = calculateInvoiceAmounts(0, 0, 20);
    assert.equal(r.grossAmount, '0.00');
    assert.equal(r.cisAmount, '0.00');
    assert.equal(r.netAmount, '0.00');
  });

  it('handles labour only (no materials)', () => {
    const r = calculateInvoiceAmounts(2000, 0, 0.3);
    assert.equal(r.grossAmount, '2000.00');
    assert.equal(r.cisAmount, '600.00');
    assert.equal(r.netAmount, '1400.00');
  });
});
