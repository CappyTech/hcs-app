'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * payrollTaxRates — database-driven UK tax year rate table.
 *
 * One document per tax year (e.g. '2025/26').  Rates should be reviewed and
 * updated each April when HMRC publishes new thresholds.  The Settings UI
 * at /settings/payroll/tax-rates manages these records.
 *
 * All threshold amounts are ANNUAL figures in GBP (£).
 * Rates (basicRate etc.) are fractions, e.g. 0.20 for 20%.
 *
 * Seeded via scripts/seed-payroll-tax-rates.js on first deploy.
 */
const payrollTaxRatesSchema = new mongoose.Schema({
  uuid: {
    type: String,
    unique: true,
    required: true,
    default: () => crypto.randomUUID()
  },

  // e.g. '2025/26' — used as the primary lookup key
  taxYear: { type: String, required: true, unique: true },

  // ── Income Tax (England, Wales, Northern Ireland) ─────────────────────────
  personalAllowance:        { type: Number, required: true },  // e.g. 12570
  basicRateLimit:           { type: Number, required: true },  // taxable income up to this → basic rate (e.g. 37700)
  higherRateThreshold:      { type: Number, required: true },  // personal allowance + basicRateLimit (e.g. 50270)
  additionalRateThreshold:  { type: Number, required: true },  // e.g. 125140
  basicRate:                { type: Number, required: true },  // e.g. 0.20
  higherRate:               { type: Number, required: true },  // e.g. 0.40
  additionalRate:           { type: Number, required: true },  // e.g. 0.45

  // ── National Insurance (Class 1 Employee) ────────────────────────────────
  niLEL:  { type: Number, required: true },  // Lower Earnings Limit (e.g. 6396)
  niPT:   { type: Number, required: true },  // Primary Threshold — employee NI starts (e.g. 12570)
  niUEL:  { type: Number, required: true },  // Upper Earnings Limit (e.g. 50270)
  niEmployeeMain:  { type: Number, required: true },  // rate between PT and UEL (e.g. 0.08)
  niEmployeeUpper: { type: Number, required: true },  // rate above UEL (e.g. 0.02)
  niEmployeeReducedRate: { type: Number, default: 0.0185 },  // category B married women's reduced rate (1.85% since Mar 2024)

  // ── National Insurance (Class 1 Employer) ────────────────────────────────
  niST:           { type: Number, required: true },  // Secondary Threshold — employer NI starts (e.g. 5000 for 2025/26)
  niEmployerRate: { type: Number, required: true },  // e.g. 0.15 (15% from April 2025)

  // ── Auto-enrolment Pension ────────────────────────────────────────────────
  aeQualifyingLower: { type: Number, required: true },  // Lower Qualifying Earnings (e.g. 6240)
  aeQualifyingUpper: { type: Number, required: true },  // Upper Qualifying Earnings (e.g. 50270)

  // ── Student Loan Thresholds (annual) ────────────────────────────────────
  studentLoanPlan1Threshold:    { type: Number, default: null },
  studentLoanPlan2Threshold:    { type: Number, default: null },
  studentLoanPlan4Threshold:    { type: Number, default: null },
  studentLoanPostgradThreshold: { type: Number, default: null },
  studentLoanRate:              { type: Number, default: 0.09 },   // 9% for Plans 1/2/4
  postgradLoanRate:             { type: Number, default: 0.06 }    // 6% for Postgrad
}, {
  timestamps: true
});

module.exports = {
  modelName: 'payrollTaxRates',
  schema: payrollTaxRatesSchema
};
