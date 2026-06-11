const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { nextDeadline, periodLabel } = require('../mongoose/services/cisReturnReminderService');

describe('cisReturnReminderService.nextDeadline', () => {
  it('returns the 19th of the current month when today is before it', () => {
    const d = nextDeadline(new Date(2026, 5, 11)); // 11 Jun 2026
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 19);
  });

  it('returns the 19th itself on deadline day', () => {
    const d = nextDeadline(new Date(2026, 5, 19));
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 19);
  });

  it('rolls to next month after the 19th', () => {
    const d = nextDeadline(new Date(2026, 5, 20)); // 20 Jun 2026
    assert.equal(d.getMonth(), 6); // July
    assert.equal(d.getDate(), 19);
  });

  it('rolls across the year boundary', () => {
    const d = nextDeadline(new Date(2026, 11, 28)); // 28 Dec 2026
    assert.equal(d.getFullYear(), 2027);
    assert.equal(d.getMonth(), 0); // January
    assert.equal(d.getDate(), 19);
  });
});

describe('cisReturnReminderService.periodLabel', () => {
  it('labels the 6th-to-5th tax period for the deadline month', () => {
    const label = periodLabel(new Date(2026, 5, 19)); // deadline 19 Jun
    assert.ok(label.includes('6 May'), label);
    assert.ok(label.includes('5 Jun 2026'), label);
  });
});
