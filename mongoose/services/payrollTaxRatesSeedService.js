'use strict';

/**
 * payrollTaxRatesSeedService.js
 *
 * Ensures the payrollTaxRates collection holds a document for every tax year
 * we ship defaults for. Runs at startup (app.js Phase 2), replacing the old
 * manual `scripts/seed-payroll-tax-rates.js` deployment step.
 *
 * Semantics:
 *  - INSERT-ONLY for whole years: an existing tax-year document is never
 *    overwritten, so rates edited by an admin in Settings → Payroll →
 *    Tax Rates survive restarts and deploys.
 *  - Targeted CORRECTIONS: values that earlier releases seeded wrongly are
 *    fixed by matching the exact bad value — a document an admin has already
 *    corrected (or otherwise changed) no longer matches and is left alone.
 *
 * Sources:
 *   HMRC — https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026
 *   HMRC — https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027
 *
 * All monetary thresholds are ANNUAL amounts in GBP (£).
 * All rates are fractions (0.20 = 20%).
 */

const logger = require('../../services/loggerService');

const DEFAULT_RATES = [
  {
    taxYear: '2025/26',
    // Income Tax — England, Wales, Northern Ireland
    personalAllowance:       12570,
    basicRateLimit:          37700,
    higherRateThreshold:     50270,  // personalAllowance + basicRateLimit
    additionalRateThreshold: 125140,
    basicRate:    0.20,
    higherRate:   0.40,
    additionalRate: 0.45,
    // Employee NI thresholds (annual)
    niLEL:  6500,   // Lower Earnings Limit (£125/week for 2025/26)
    niPT:   12570,  // Primary Threshold (aligned with personal allowance since 2022)
    niUEL:  50270,  // Upper Earnings Limit
    niEmployeeMain:  0.08,   // 8% between PT and UEL (reduced from 10% Oct 2024)
    niEmployeeUpper: 0.02,   // 2% above UEL
    niEmployeeReducedRate: 0.0185, // category B married women's reduced rate
    // Employer NI
    niST:           5000,    // Secondary Threshold — reduced from £9,100 to £5,000 for 2025/26
    niEmployerRate: 0.15,    // 15% — increased from 13.8% at Autumn Budget 2024, effective 6 April 2025
    // Auto-enrolment pension qualifying earnings
    aeQualifyingLower: 6240,
    aeQualifyingUpper: 50270,
    // Student loan thresholds (annual, pre-tax income)
    studentLoanPlan1Threshold:    26065,
    studentLoanPlan2Threshold:    28470,
    studentLoanPlan4Threshold:    32745,
    studentLoanPostgradThreshold: 21000,
    studentLoanRate:   0.09,
    postgradLoanRate:  0.06
  },
  {
    taxYear: '2026/27',
    // Income Tax
    personalAllowance:       12570,   // frozen until 2028 per OBR
    basicRateLimit:          37700,
    higherRateThreshold:     50270,
    additionalRateThreshold: 125140,
    basicRate:    0.20,
    higherRate:   0.40,
    additionalRate: 0.45,
    // Employee NI
    niLEL:  6708,   // per HMRC rates and thresholds for employers 2026/27
    niPT:   12570,
    niUEL:  50270,
    niEmployeeMain:  0.08,
    niEmployeeUpper: 0.02,
    niEmployeeReducedRate: 0.0185,
    // Employer NI
    niST:           5000,
    niEmployerRate: 0.15,
    // Auto-enrolment
    aeQualifyingLower: 6240,
    aeQualifyingUpper: 50270,
    // Student loan — per HMRC 2026/27 published thresholds
    studentLoanPlan1Threshold:    26900,
    studentLoanPlan2Threshold:    29385,
    studentLoanPlan4Threshold:    33795,
    studentLoanPostgradThreshold: 21000,
    studentLoanRate:   0.09,
    postgradLoanRate:  0.06
  }
];

/**
 * Known-bad values written by seed scripts before v6.8.6, keyed by the exact
 * wrong value so an admin-edited document is never touched.
 */
const CORRECTIONS = [
  // Employer NI rate rose to 15% at Autumn Budget 2024 (from 6 April 2025)
  { taxYear: '2025/26', field: 'niEmployerRate', from: 0.138, to: 0.15 },
  { taxYear: '2026/27', field: 'niEmployerRate', from: 0.138, to: 0.15 },
  // 2025/26 was seeded with 2024/25 student-loan thresholds and LEL
  { taxYear: '2025/26', field: 'studentLoanPlan1Threshold', from: 24990, to: 26065 },
  { taxYear: '2025/26', field: 'studentLoanPlan4Threshold', from: 31395, to: 32745 },
  { taxYear: '2025/26', field: 'niLEL', from: 6396, to: 6500 },
  // 2026/27 was seeded with pre-publication estimates
  { taxYear: '2026/27', field: 'niLEL', from: 6644, to: 6708 },
  { taxYear: '2026/27', field: 'studentLoanPlan1Threshold', from: 26065, to: 26900 },
  { taxYear: '2026/27', field: 'studentLoanPlan2Threshold', from: 29270, to: 29385 },
  { taxYear: '2026/27', field: 'studentLoanPlan4Threshold', from: 32745, to: 33795 }
];

/**
 * Seed missing tax years and apply targeted corrections.
 *
 * @param {mongoose.Model} PayrollTaxRates — the INTERNAL.payrollTaxRates model
 * @returns {Promise<{ created: string[], corrected: number }>}
 */
async function ensureSeeded(PayrollTaxRates) {
  if (!PayrollTaxRates) throw new Error('payrollTaxRates model not available');

  const created = [];
  for (const rates of DEFAULT_RATES) {
    const res = await PayrollTaxRates.updateOne(
      { taxYear: rates.taxYear },
      { $setOnInsert: rates },
      { upsert: true, setDefaultsOnInsert: true }
    );
    if (res.upsertedCount > 0) created.push(rates.taxYear);
  }

  let corrected = 0;
  for (const c of CORRECTIONS) {
    const res = await PayrollTaxRates.updateOne(
      { taxYear: c.taxYear, [c.field]: c.from },
      { $set: { [c.field]: c.to } }
    );
    if (res.modifiedCount > 0) {
      corrected += res.modifiedCount;
      logger.warn(`[payrollTaxRatesSeed] Corrected ${c.taxYear} ${c.field}: ${c.from} → ${c.to}`);
    }
  }

  // Backfill the reduced-rate field on documents created before it existed
  const backfill = await PayrollTaxRates.updateMany(
    { niEmployeeReducedRate: { $exists: false } },
    { $set: { niEmployeeReducedRate: 0.0185 } }
  );
  corrected += backfill.modifiedCount || 0;

  return { created, corrected };
}

module.exports = { DEFAULT_RATES, CORRECTIONS, ensureSeeded };
