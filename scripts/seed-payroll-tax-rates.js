#!/usr/bin/env node
'use strict';

/**
 * scripts/seed-payroll-tax-rates.js
 *
 * Seeds UK PAYE/NI/pension tax rates for 2025/26 and 2026/27 into the
 * INTERNAL database payrollTaxRates collection.
 *
 * Run once after deployment:
 *   node scripts/seed-payroll-tax-rates.js
 *
 * Safe to re-run — uses upsert so existing records are updated, not duplicated.
 *
 * Sources:
 *   HMRC — https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026
 *   HMRC — https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027
 */

require('dotenv').config();

const mongoose = require('mongoose');
const configService = require('../services/configService');

// ── Tax rate data ────────────────────────────────────────────────────────────
// All monetary thresholds are ANNUAL amounts in GBP (£).
// All rates are fractions (0.20 = 20%).

const rates = [
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

// ── Connection ───────────────────────────────────────────────────────────────

const { payrollTaxRatesSchema } = (() => {
  const m = require('../mongoose/models/mongoose/INTERNAL/payrollTaxRates');
  return { payrollTaxRatesSchema: m.schema };
})();

async function run() {
  const rawUri = configService.get('MONGO_URI', '');
  const internalDb = configService.get('MONGO_DBNAME_INTERNAL', configService.get('MONGO_DBNAME', 'internal'));

  let uri;
  if (rawUri && rawUri.trim()) {
    // Replace db segment
    uri = rawUri.replace(/\/[^/?]+(\?|$)/, `/${internalDb}$1`);
  } else {
    const host = configService.get('MONGO_HOST', 'localhost');
    const port = configService.get('MONGO_PORT', '27017');
    const user = configService.get('MONGO_USER', '');
    const pass = configService.get('MONGO_PASS', '');
    const authSource = configService.get('MONGO_AUTH_SOURCE', 'admin');
    if (user && pass) {
      uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${internalDb}?authSource=${authSource}`;
    } else {
      uri = `mongodb://${host}:${port}/${internalDb}`;
    }
  }

  const conn = await mongoose.createConnection(uri).asPromise();
  const PayrollTaxRates = conn.model('payrollTaxRates', payrollTaxRatesSchema);

  let created = 0;
  let updated = 0;

  for (const rate of rates) {
    const existing = await PayrollTaxRates.findOne({ taxYear: rate.taxYear });
    if (existing) {
      await PayrollTaxRates.updateOne({ taxYear: rate.taxYear }, { $set: rate });
      console.log(`  ✔  Updated  ${rate.taxYear}`);
      updated++;
    } else {
      await PayrollTaxRates.create(rate);
      console.log(`  ✔  Created  ${rate.taxYear}`);
      created++;
    }
  }

  await conn.close();
  console.log(`\nDone: ${created} created, ${updated} updated.`);
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
