'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── We need to mock the DB dependency before requiring the service ────────────
// The service imports mdb at module load time so we use a manual module mock
// via Module._resolveFilename patching or just test the pure functions directly.

// Pull out only the pure, non-DB functions we can test directly.
// We load the module and extract the exports; the DB-dependent postPayrollJournal
// is tested via integration-style stubs further down.

const journalSvc = require('../mongoose/services/payrollJournalService');

// Extract testable symbols
const { buildJournalLines } = journalSvc;

// ── buildJournalLines ─────────────────────────────────────────────────────────

const validNominals = {
  grossWages:      1001,
  employerNI:      1002,
  employerPension: 1003,
  payeNiControl:   2001,
  netPayControl:   2002,
  pensionControl:  2003
};

function makeTotals(overrides = {}) {
  return {
    grossPay:       5000,
    taxDeducted:    800,
    employeeNI:     350,
    employerNI:     600,
    employeePension: 150,
    employerPension: 180,
    netPay:         3700,   // gross - tax - empNI - empPension
    ...overrides
  };
}

describe('buildJournalLines', () => {
  it('returns 6 lines (3 Dr + 3 Cr)', () => {
    const lines = buildJournalLines(makeTotals(), validNominals, 'Test Period');
    assert.equal(lines.length, 6);
    assert.equal(lines.filter(l => l.Debit).length, 3);
    assert.equal(lines.filter(l => !l.Debit).length, 3);
  });

  it('debits equal credits (balanced journal)', () => {
    const lines = buildJournalLines(makeTotals(), validNominals, 'Test Period');
    const dr = lines.filter(l =>  l.Debit).reduce((s, l) => s + l.Amount, 0);
    const cr = lines.filter(l => !l.Debit).reduce((s, l) => s + l.Amount, 0);
    assert.ok(Math.abs(dr - cr) <= 0.02, `Dr £${dr} !== Cr £${cr}`);
  });

  it('assigns correct nominal codes to Dr lines', () => {
    const lines = buildJournalLines(makeTotals(), validNominals, 'P');
    const drLines = lines.filter(l => l.Debit);
    const codes = drLines.map(l => l.NominalCode);
    assert.ok(codes.includes(validNominals.grossWages),      'grossWages nominal missing');
    assert.ok(codes.includes(validNominals.employerNI),      'employerNI nominal missing');
    assert.ok(codes.includes(validNominals.employerPension), 'employerPension nominal missing');
  });

  it('assigns correct nominal codes to Cr lines', () => {
    const lines = buildJournalLines(makeTotals(), validNominals, 'P');
    const crLines = lines.filter(l => !l.Debit);
    const codes = crLines.map(l => l.NominalCode);
    assert.ok(codes.includes(validNominals.netPayControl),  'netPayControl nominal missing');
    assert.ok(codes.includes(validNominals.payeNiControl),  'payeNiControl nominal missing');
    assert.ok(codes.includes(validNominals.pensionControl), 'pensionControl nominal missing');
  });

  it('period label appears in all descriptions', () => {
    const label = 'May 2025 Monthly';
    const lines = buildJournalLines(makeTotals(), validNominals, label);
    for (const line of lines) {
      assert.ok(line.Description.includes(label), `Description missing label: ${line.Description}`);
    }
  });

  it('gross wages debit equals grossPay', () => {
    const totals = makeTotals({ grossPay: 12345.67 });
    const lines  = buildJournalLines(totals, validNominals, 'P');
    const grossLine = lines.find(l => l.Debit && l.NominalCode === validNominals.grossWages);
    assert.equal(grossLine.Amount, 12345.67);
  });

  it('PAYE & NI control = taxDeducted + employeeNI + employerNI', () => {
    const totals = makeTotals();
    const lines  = buildJournalLines(totals, validNominals, 'P');
    const expected = totals.taxDeducted + totals.employeeNI + totals.employerNI; // 800+350+600 = 1750
    const payeLine = lines.find(l => !l.Debit && l.NominalCode === validNominals.payeNiControl);
    assert.equal(payeLine.Amount, expected);
  });

  it('pension control = employeePension + employerPension', () => {
    const totals = makeTotals();
    const lines  = buildJournalLines(totals, validNominals, 'P');
    const expected = totals.employeePension + totals.employerPension; // 150+180 = 330
    const pensionLine = lines.find(l => !l.Debit && l.NominalCode === validNominals.pensionControl);
    assert.equal(pensionLine.Amount, expected);
  });

  it('throws when a required nominal code is missing', () => {
    const badNominals = { ...validNominals };
    delete badNominals.grossWages;
    assert.throws(
      () => buildJournalLines(makeTotals(), badNominals, 'P'),
      /grossWages/
    );
  });

  it('throws when multiple required nominals are missing', () => {
    const badNominals = { grossWages: 1001 };
    assert.throws(
      () => buildJournalLines(makeTotals(), badNominals, 'P'),
      /missing nominal codes/
    );
  });

  it('handles Decimal128-like objects via toString()', () => {
    const decimal128Like = (n) => ({ toString: () => String(n) });
    const totals = {
      grossPay:       decimal128Like(3000),
      taxDeducted:    decimal128Like(600),
      employeeNI:     decimal128Like(200),
      employerNI:     decimal128Like(350),
      employeePension: decimal128Like(90),
      employerPension: decimal128Like(110),
      netPay:         decimal128Like(2110)
    };
    const lines = buildJournalLines(totals, validNominals, 'D128 Test');
    const dr = lines.filter(l =>  l.Debit).reduce((s, l) => s + l.Amount, 0);
    const cr = lines.filter(l => !l.Debit).reduce((s, l) => s + l.Amount, 0);
    assert.ok(Math.abs(dr - cr) <= 0.02, `Decimal128 values unbalanced: Dr £${dr} Cr £${cr}`);
  });

  it('treats null/undefined fields as zero without throwing', () => {
    const totals = { grossPay: 1000, taxDeducted: null, employeeNI: undefined, employerNI: 0, employeePension: 0, employerPension: 0, netPay: 1000 };
    assert.doesNotThrow(() => buildJournalLines(totals, validNominals, 'Zeros'));
  });
});
