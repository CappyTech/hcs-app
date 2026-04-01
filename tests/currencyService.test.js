const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatCurrency, rounding } = require('../services/currencyService');

// ── formatCurrency ───────────────────────────────────────────────────────────

describe('formatCurrency', () => {
  it('formats positive amount with £ and 2 decimals', () => {
    assert.equal(formatCurrency(1234.5), '£1234.50');
  });

  it('formats zero', () => {
    assert.equal(formatCurrency(0), '£0.00');
  });

  it('formats negative amount', () => {
    assert.equal(formatCurrency(-50.1), '£-50.10');
  });

  it('formats integer to 2 decimal places', () => {
    assert.equal(formatCurrency(100), '£100.00');
  });

  it('formats small fractional amounts', () => {
    assert.equal(formatCurrency(0.99), '£0.99');
  });

  it('handles very large numbers', () => {
    assert.equal(formatCurrency(1000000), '£1000000.00');
  });

  it('throws for string input', () => {
    assert.throws(() => formatCurrency('100'), /must be a number/i);
  });

  it('returns £0.00 for null input', () => {
    assert.equal(formatCurrency(null), '£0.00');
  });

  it('returns £0.00 for undefined input', () => {
    assert.equal(formatCurrency(undefined), '£0.00');
  });

  it('formats NaN as "£NaN"', () => {
    // NaN passes typeof === 'number' so formatCurrency does not throw
    assert.equal(formatCurrency(NaN), '£NaN');
  });
});

// ── rounding ─────────────────────────────────────────────────────────────────

describe('rounding', () => {
  it('rounds up with Math.ceil', () => {
    assert.equal(rounding(1.1, true), 2);
  });

  it('rounds down with Math.floor', () => {
    assert.equal(rounding(1.9, false), 1);
  });

  it('ceil of integer returns same integer', () => {
    assert.equal(rounding(5, true), 5);
  });

  it('floor of integer returns same integer', () => {
    assert.equal(rounding(5, false), 5);
  });

  it('ceil of negative rounds toward zero', () => {
    assert.equal(rounding(-1.5, true), -1);
  });

  it('floor of negative rounds away from zero', () => {
    assert.equal(rounding(-1.5, false), -2);
  });

  it('rounds zero to zero', () => {
    assert.equal(rounding(0, true), 0);
    assert.equal(rounding(0, false), 0);
  });
});
