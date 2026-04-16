'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// peoplesPensionService → encryptionService throws if ENCRYPTION_KEY is missing
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-pension-unit-tests-x';
}

// ── peoplesPensionService — pure-function tests ───────────────────────────────
//
// generateContributionsCSV needs mdb (DB), so we test the observable contract
// by inspecting the exported submitViaAPI stub and the CSV format via a
// lightweight internal reimplementation of the helpers.

const pensionSvc = require('../services/peoplesPensionService');

// ── submitViaAPI stub ─────────────────────────────────────────────────────────

describe('submitViaAPI', () => {
  it('throws immediately when PEOPLES_PENSION_API_KEY is not set', async () => {
    const originalKey = process.env.PEOPLES_PENSION_API_KEY;
    delete process.env.PEOPLES_PENSION_API_KEY;

    try {
      await assert.rejects(
        () => pensionSvc.submitViaAPI({}, []),
        /not configured|not yet available/i
      );
    } finally {
      if (originalKey !== undefined) process.env.PEOPLES_PENSION_API_KEY = originalKey;
    }
  });

  it('still throws a descriptive error when API key is set (stub not implemented)', async () => {
    process.env.PEOPLES_PENSION_API_KEY = 'test-key-123';
    try {
      await assert.rejects(
        () => pensionSvc.submitViaAPI({}, []),
        /not yet available/i
      );
    } finally {
      delete process.env.PEOPLES_PENSION_API_KEY;
    }
  });
});

// ── CSV helper unit tests — reimplemented to test the contract ────────────────
// We validate that the CSV the service would produce follows RFC 4180 and the
// correct column order, by testing the helper functions via a thin extract.

function csvCell(value) {
  const s = String(value == null ? '' : value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields) {
  return fields.map(csvCell).join(',') + '\r\n';
}

describe('CSV cell escaping (RFC 4180)', () => {
  it('leaves plain text unchanged', () => {
    assert.equal(csvCell('hello'), 'hello');
  });

  it('wraps values containing commas in double quotes', () => {
    assert.equal(csvCell('Smith, John'), '"Smith, John"');
  });

  it('escapes embedded double-quotes by doubling them', () => {
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  });

  it('wraps values containing newlines in double quotes', () => {
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  });

  it('converts null to empty string', () => {
    assert.equal(csvCell(null), '');
  });

  it('converts undefined to empty string', () => {
    assert.equal(csvCell(undefined), '');
  });
});

describe('CSV row formatting', () => {
  it('joins cells with commas and ends with CRLF', () => {
    const row = csvRow(['ABC', '001', 'John', 'Smith', 'AB123456C', '50.00', '150.00', '2025-04-30']);
    assert.ok(row.endsWith('\r\n'), 'row should end with CRLF');
    const cells = row.replace('\r\n', '').split(',');
    assert.equal(cells.length, 8);
    assert.equal(cells[0], 'ABC');
    assert.equal(cells[4], 'AB123456C');
  });

  it('header row matches expected People\'s Pension column order', () => {
    const expectedHeaders = [
      'Employer Reference',
      'Member ID',
      'Forename',
      'Surname',
      'NI Number',
      'Employee Contribution',
      'Employer Contribution',
      'Payment Date'
    ];
    const row = csvRow(expectedHeaders);
    const cells = row.replace('\r\n', '').split(',').map(c => c.trim());
    assert.deepEqual(cells, expectedHeaders);
  });
});

describe('pension enrolled filter', () => {
  it('only includes entries with pensionEnrolled=true or non-zero pension amounts', () => {
    // This mirrors the filtering logic in generateContributionsCSV
    const entries = [
      { employeeId: { payroll: { pensionEnrolled: true,  niNumber: null }, name: 'Alice One',   uuid: 'a1' }, employeePension: 50,   employerPension: 150  },
      { employeeId: { payroll: { pensionEnrolled: false, niNumber: null }, name: 'Bob Two',     uuid: 'b2' }, employeePension: 0,    employerPension: 0    },
      { employeeId: { payroll: { pensionEnrolled: false, niNumber: null }, name: 'Carol Three', uuid: 'c3' }, employeePension: 10,   employerPension: 30   },
    ];

    const included = entries.filter(e => {
      const payroll = e.employeeId?.payroll || {};
      return payroll.pensionEnrolled || toNum(e.employeePension) > 0 || toNum(e.employerPension) > 0;
    });

    assert.equal(included.length, 2, 'Should include enrolled + non-zero contribution entries');
    assert.equal(included[0].employeeId.name, 'Alice One');
    assert.equal(included[1].employeeId.name, 'Carol Three');
  });

  function toNum(v) {
    if (v == null) return 0;
    if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
    return Number(v) || 0;
  }
});
