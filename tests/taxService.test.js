const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const moment = require('moment-timezone');
const {
  getCurrentTaxYear,
  getTaxYearStartEnd,
  getCurrentMonthlyReturn,
  calculateTaxYearAndMonth,
} = require('../services/taxService');

// ── getCurrentTaxYear ────────────────────────────────────────────────────────

describe('getCurrentTaxYear', () => {
  it('returns a number', () => {
    const year = getCurrentTaxYear();
    assert.equal(typeof year, 'number');
  });

  it('returns the correct tax year for today', () => {
    const today = moment.tz('Europe/London');
    const cutoff = moment.tz({ year: today.year(), month: 3, day: 6 }, 'Europe/London');
    const expected = today.isBefore(cutoff) ? today.year() - 1 : today.year();
    assert.equal(getCurrentTaxYear(), expected);
  });
});

// ── getTaxYearStartEnd ───────────────────────────────────────────────────────

describe('getTaxYearStartEnd', () => {
  it('tax year 2025 starts on 6 April 2025', () => {
    const { start } = getTaxYearStartEnd(2025);
    const m = moment(start).tz('Europe/London');
    assert.equal(m.month(), 3); // April = 3
    assert.equal(m.date(), 6);
    assert.equal(m.year(), 2025);
  });

  it('tax year 2025 ends on 5 April 2026', () => {
    const { end } = getTaxYearStartEnd(2025);
    const m = moment(end).tz('Europe/London');
    assert.equal(m.month(), 3);
    assert.equal(m.date(), 5);
    assert.equal(m.year(), 2026);
  });

  it('tax year 2024 starts on 6 April 2024', () => {
    const { start } = getTaxYearStartEnd(2024);
    const m = moment(start).tz('Europe/London');
    assert.equal(m.date(), 6);
    assert.equal(m.month(), 3);
    assert.equal(m.year(), 2024);
  });

  it('start and end span exactly 364 or 365 days', () => {
    const { start, end } = getTaxYearStartEnd(2025);
    const days = moment(end).diff(moment(start), 'days');
    assert.ok(days === 364 || days === 365, `Expected 364 or 365 days, got ${days}`);
  });
});

// ── calculateTaxYearAndMonth ─────────────────────────────────────────────────

describe('calculateTaxYearAndMonth', () => {
  it('6 April 2025 is tax year 2025, month 1', () => {
    const r = calculateTaxYearAndMonth('2025-04-06');
    assert.equal(r.taxYear, 2025);
    assert.equal(r.taxMonth, 1);
  });

  it('5 April 2025 is tax year 2024, month 12', () => {
    const r = calculateTaxYearAndMonth('2025-04-05');
    assert.equal(r.taxYear, 2024);
    assert.equal(r.taxMonth, 12);
  });

  it('1 January 2026 is tax year 2025, month 9', () => {
    // Apr6=1, May6=2, Jun6=3, Jul6=4, Aug6=5, Sep6=6, Oct6=7, Nov6=8, Dec6=9
    // Jan 1 is before the 6th so still in month 9 (Dec 6 – Jan 5)
    const r = calculateTaxYearAndMonth('2026-01-01');
    assert.equal(r.taxYear, 2025);
    assert.equal(r.taxMonth, 9);
  });

  it('6 July 2025 is tax year 2025, month 4', () => {
    // Apr=1, May=2, Jun=3, Jul=4
    const r = calculateTaxYearAndMonth('2025-07-06');
    assert.equal(r.taxYear, 2025);
    assert.equal(r.taxMonth, 4);
  });

  it('March 2026 is tax year 2025, month 12', () => {
    const r = calculateTaxYearAndMonth('2026-03-25');
    assert.equal(r.taxYear, 2025);
    assert.equal(r.taxMonth, 12);
  });

  it('returns null for falsy input', () => {
    const r = calculateTaxYearAndMonth(null);
    assert.equal(r.taxYear, null);
    assert.equal(r.taxMonth, null);
  });

  it('returns null for undefined input', () => {
    const r = calculateTaxYearAndMonth(undefined);
    assert.equal(r.taxYear, null);
    assert.equal(r.taxMonth, null);
  });

  it('returns null for empty string', () => {
    const r = calculateTaxYearAndMonth('');
    assert.equal(r.taxYear, null);
    assert.equal(r.taxMonth, null);
  });
});

// ── getCurrentMonthlyReturn ──────────────────────────────────────────────────

describe('getCurrentMonthlyReturn', () => {
  it('month 1 of tax year 2025 starts on 6 April 2025', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    const start = moment(r.periodStart).tz('Europe/London');
    assert.equal(start.month(), 3);
    assert.equal(start.date(), 6);
    assert.equal(start.year(), 2025);
  });

  it('month 1 ends on 5 May 2025', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    const end = moment(r.periodEnd).tz('Europe/London');
    assert.equal(end.month(), 4); // May
    assert.equal(end.date(), 5);
  });

  it('month 12 starts on 6 March and ends on 5 April', () => {
    const r = getCurrentMonthlyReturn(2025, 12);
    const start = moment(r.periodStart).tz('Europe/London');
    const end = moment(r.periodEnd).tz('Europe/London');
    assert.equal(start.month(), 2); // March
    assert.equal(start.date(), 6);
    assert.equal(end.month(), 3); // April
    assert.equal(end.date(), 5);
  });

  it('submission deadline is 6 days after period end', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    const end = moment(r.periodEnd).tz('Europe/London').startOf('day');
    const deadline = moment(r.submissionDeadline).tz('Europe/London').startOf('day');
    const diff = deadline.diff(end, 'days');
    assert.equal(diff, 6);
  });

  it('submission open date is 2 days after period end', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    const end = moment(r.periodEnd).tz('Europe/London').startOf('day');
    const open = moment(r.submissionOpenDate).tz('Europe/London').startOf('day');
    assert.equal(open.diff(end, 'days'), 2);
  });

  it('HMRC update date is 11 days after period end', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    const end = moment(r.periodEnd).tz('Europe/London').startOf('day');
    const hmrc = moment(r.hmrcUpdateDate).tz('Europe/London').startOf('day');
    assert.equal(hmrc.diff(end, 'days'), 11);
  });

  it('includes display format strings', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    assert.ok(r.periodStartDisplay.includes('April'));
    assert.ok(r.periodEndDisplay.includes('May'));
  });

  it('includes DST flags', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    assert.equal(typeof r.isDST, 'boolean');
    assert.equal(typeof r.isEndDST, 'boolean');
  });

  it('days-until fields are numbers', () => {
    const r = getCurrentMonthlyReturn(2025, 1);
    assert.equal(typeof r.submissionDeadlineInDays, 'number');
    assert.equal(typeof r.submissionOpenDateInDays, 'number');
    assert.equal(typeof r.hmrcUpdateDateInDays, 'number');
  });

  it('month 6 (September) starts on 6 September', () => {
    // Month 6: Apr(1) May(2) Jun(3) Jul(4) Aug(5) Sep(6)
    const r = getCurrentMonthlyReturn(2025, 6);
    const start = moment(r.periodStart).tz('Europe/London');
    assert.equal(start.month(), 8); // September = 8
    assert.equal(start.date(), 6);
  });
});
