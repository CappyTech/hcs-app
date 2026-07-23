#!/usr/bin/env node
/**
 * scripts/seed-payroll-tax-rates.js
 *
 * FORCE-resets UK PAYE/NI/pension tax rates to the shipped defaults
 * (see mongoose/services/payrollTaxRatesSeedService.js — single source of
 * truth for the rate data).
 *
 * ⚠️  You normally do NOT need this script: the application seeds missing
 * tax years and corrects known-bad values automatically at startup, and
 * admins can edit rates in Settings → Payroll → Tax Rates.
 *
 * Running this OVERWRITES any admin-edited values with the shipped defaults.
 * Use it only to recover from a corrupted rate table:
 *   node scripts/seed-payroll-tax-rates.js
 */

__dotenv.config();

import mongoose from 'mongoose';
import configService from '../services/configService.js';
import __payrollTaxRatesSeedService from '../mongoose/services/payrollTaxRatesSeedService.js';
import __dotenv from 'dotenv';
import m from '../mongoose/models/mongoose/INTERNAL/payrollTaxRates.js';
const { DEFAULT_RATES } = __payrollTaxRatesSeedService;

const { payrollTaxRatesSchema } = (() => {
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

  for (const rate of DEFAULT_RATES) {
    const existing = await PayrollTaxRates.findOne({ taxYear: rate.taxYear });
    if (existing) {
      await PayrollTaxRates.updateOne({ taxYear: rate.taxYear }, { $set: rate });
      console.log(`  ✔  Reset    ${rate.taxYear}`);
      updated++;
    } else {
      await PayrollTaxRates.create(rate);
      console.log(`  ✔  Created  ${rate.taxYear}`);
      created++;
    }
  }

  await conn.close();
  console.log(`\nDone: ${created} created, ${updated} reset to defaults.`);
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
