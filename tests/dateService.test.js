import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import __dateService from '../services/dateService.js';
const { slimDateTime } = __dateService;

// ── Default format (DD/MM/YYYY) ─────────────────────────────────────────────

describe('slimDateTime — default format', () => {
  it('formats a date as DD/MM/YYYY', () => {
    assert.equal(slimDateTime('2025-12-25'), '25/12/2025');
  });

  it('formats ISO datetime', () => {
    assert.equal(slimDateTime('2025-06-15T14:30:00Z'), '15/06/2025');
  });
});

// ── "Never" for falsy input ──────────────────────────────────────────────────

describe('slimDateTime — falsy input', () => {
  it('returns "Never" for null', () => {
    assert.equal(slimDateTime(null), 'Never');
  });

  it('returns "Never" for undefined', () => {
    assert.equal(slimDateTime(undefined), 'Never');
  });

  it('returns "Never" for empty string', () => {
    assert.equal(slimDateTime(''), 'Never');
  });
});

// ── Invalid date ─────────────────────────────────────────────────────────────

describe('slimDateTime — invalid date', () => {
  it('returns "Invalid date" for gibberish', () => {
    assert.equal(slimDateTime('not-a-date'), 'Invalid date');
  });
});

// ── includeTime option ───────────────────────────────────────────────────────

describe('slimDateTime — includeTime', () => {
  it('appends HH:mm to DD/MM/YYYY', () => {
    const result = slimDateTime('2025-06-15T14:30:00Z', ['includeTime'], 'Europe/London');
    assert.match(result, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });
});

// ── forDateInput option ──────────────────────────────────────────────────────

describe('slimDateTime — forDateInput', () => {
  it('returns YYYY-MM-DD for date input fields', () => {
    assert.equal(slimDateTime('2025-12-25', ['forDateInput']), '2025-12-25');
  });

  it('handles ISO datetime', () => {
    const result = slimDateTime('2025-06-15T14:30:00Z', ['forDateInput']);
    assert.equal(result, '2025-06-15');
  });
});

// ── displayFormat option ─────────────────────────────────────────────────────

describe('slimDateTime — displayFormat', () => {
  it('returns "Do MMMM YYYY" format', () => {
    const result = slimDateTime('2025-12-25', ['displayFormat']);
    assert.ok(result.includes('December'));
    assert.ok(result.includes('2025'));
    assert.ok(result.includes('25th'));
  });

  it('with includeTime adds HH:mm', () => {
    const result = slimDateTime('2025-12-25T10:30:00Z', ['displayFormat', 'includeTime']);
    assert.ok(result.includes('December'));
    assert.match(result, /\d{2}:\d{2}/);
  });
});

// ── timezone handling ────────────────────────────────────────────────────────

describe('slimDateTime — timezone', () => {
  it('defaults to Europe/London', () => {
    // During BST (summer): UTC 23:00 on June 14 = local 00:00 on June 15
    const result = slimDateTime('2025-06-14T23:00:00Z');
    assert.equal(result, '15/06/2025'); // BST = UTC+1
  });

  it('respects explicit timezone', () => {
    const result = slimDateTime('2025-06-15T00:00:00Z', [], 'America/New_York');
    // Midnight UTC = 14 Jun 8pm EST
    assert.equal(result, '14/06/2025');
  });
});
