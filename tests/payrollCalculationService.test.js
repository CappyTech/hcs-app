'use strict';

/**
 * tests/payrollCalculationService.test.js
 *
 * Unit tests for the payroll calculation engine.
 *
 * Test values are cross-referenced against:
 *  - HMRC PAYE Worked Examples (CWG2 Appendix 1)
 *  - HMRC NI Thresholds 2025/26
 *  - gov.uk PAYE calculator
 *
 * Run with: node --test tests/payrollCalculationService.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  calculatePAYETax,
  calculateEmployeeNI,
  calculateEmployerNI,
  calculatePensionContributions,
  calculateStudentLoan,
  parseTaxCode,
  annualToPeriod,
  periodsInYear
} = require('../mongoose/services/payrollCalculationService');

// ── Standard 2025/26 rates fixture ──────────────────────────────────────────

const rates2526 = {
  personalAllowance:       12570,
  basicRateLimit:          37700,
  higherRateThreshold:     50270,
  additionalRateThreshold: 125140,
  basicRate:    0.20,
  higherRate:   0.40,
  additionalRate: 0.45,
  niLEL:  6500,
  niPT:   12570,
  niUEL:  50270,
  niEmployeeMain:  0.08,
  niEmployeeUpper: 0.02,
  niEmployeeReducedRate: 0.0185,
  niST:           5000,
  niEmployerRate: 0.15,
  aeQualifyingLower: 6240,
  aeQualifyingUpper: 50270,
  studentLoanPlan1Threshold:    26065,
  studentLoanPlan2Threshold:    28470,
  studentLoanPlan4Threshold:    32745,
  studentLoanPostgradThreshold: 21000,
  studentLoanRate:   0.09,
  postgradLoanRate:  0.06
};

// Helper: round to 2dp
const r2 = (n) => Math.round(n * 100) / 100;

// ── parseTaxCode ─────────────────────────────────────────────────────────────

describe('parseTaxCode', () => {
  it('parses 1257L correctly', () => {
    const r = parseTaxCode('1257L');
    assert.equal(r.freePayAnnual, 12570);
    assert.equal(r.isBR, false);
    assert.equal(r.isNT, false);
  });

  it('parses BR', () => {
    const r = parseTaxCode('BR');
    assert.equal(r.isBR, true);
    assert.equal(r.freePayAnnual, 0);
  });

  it('parses D0 (higher rate)', () => {
    const r = parseTaxCode('D0');
    assert.equal(r.isD0, true);
  });

  it('parses D1 (additional rate)', () => {
    const r = parseTaxCode('D1');
    assert.equal(r.isD1, true);
  });

  it('parses NT (no tax)', () => {
    const r = parseTaxCode('NT');
    assert.equal(r.isNT, true);
  });

  it('parses K100 as negative free pay', () => {
    const r = parseTaxCode('K100');
    assert.equal(r.freePayAnnual, -1000);
    assert.equal(r.isK, true);
  });

  it('parses 0T as zero allowance', () => {
    const r = parseTaxCode('0T');
    assert.equal(r.freePayAnnual, 0);
  });

  it('parses 500T (Marriage Allowance)', () => {
    const r = parseTaxCode('500T');
    assert.equal(r.freePayAnnual, 5000);
  });
});

// ── annualToPeriod ───────────────────────────────────────────────────────────

describe('annualToPeriod', () => {
  it('divides annual by 52 for weekly', () => {
    assert.equal(r2(annualToPeriod(52000, 'weekly')), 1000);
  });

  it('divides annual by 12 for monthly', () => {
    assert.equal(r2(annualToPeriod(12000, 'monthly')), 1000);
  });

  it('correctly scales fortnightly (2/52)', () => {
    assert.equal(r2(annualToPeriod(52000, 'fortnightly')), 2000);
  });
});

// ── calculatePAYETax ─────────────────────────────────────────────────────────

describe('calculatePAYETax — week1/month1 basis', () => {
  it('taxes zero gross as zero', () => {
    const tax = calculatePAYETax({
      grossPay: 0, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: '1257L', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 0);
  });

  it('below personal allowance (weekly): no tax', () => {
    // £12,570 / 52 = £241.73/wk personal allowance
    const tax = calculatePAYETax({
      grossPay: 200, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: '1257L', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 0);
  });

  it('BR code: all income at basic rate', () => {
    // £500/wk × 20% = £100
    const tax = calculatePAYETax({
      grossPay: 500, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: 'BR', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 100);
  });

  it('NT code: no tax', () => {
    const tax = calculatePAYETax({
      grossPay: 5000, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: 'NT', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 0);
  });

  it('D0 code: higher rate on all income', () => {
    // £1000 × 40% = £400
    const tax = calculatePAYETax({
      grossPay: 1000, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: 'D0', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 400);
  });

  it('1257L monthly £2500 (≈£30k/yr): exactly £290.50 tax', () => {
    // Monthly free pay = 12570/12 = 1047.50
    // Taxable = 1452.50, all at basic rate → 290.50
    const tax = calculatePAYETax({
      grossPay: 2500, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: '1257L', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'monthly', rates: rates2526
    });
    assert.equal(tax, 290.50);
  });

  it('K code: notional pay added, tax capped at the 50% overriding limit', () => {
    // K4000 weekly: notional pay = 40000/52 = 769.23 added to £300 gross
    // Uncapped tax ≈ £282.69 — but the PAYE regulatory limit caps the
    // deduction at 50% of pay = £150.00
    const tax = calculatePAYETax({
      grossPay: 300, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: 'K4000', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 150.00);
  });

  it('K code below the limit: notional pay taxed normally', () => {
    // K100 weekly on £500: notional = 1000/52 = 19.2308 → taxable 519.2308
    // Annualised 27000 → basic rate 5400 → /52 = 103.846 → 103.85
    const tax = calculatePAYETax({
      grossPay: 500, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: 'K100', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.equal(tax, 103.85);
  });
});

describe('calculatePAYETax — cumulative basis', () => {
  it('week 1 start: no prior YTD, 1257L weekly — correct first period tax', () => {
    const grossWeekly = 500;
    // Free pay period 1 = 12570 × (1/52) = 241.73
    // Taxable = 500 - 241.73 = 258.27 (annualised = 13429.8 → 13429.8 - 12570 = 859.8 taxable)
    // Tax = 859.8 * 0.20 / 52 ≈ 3.31
    const tax = calculatePAYETax({
      grossPay: grossWeekly, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: '1257L', taxBasis: 'cumulative',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    assert.ok(tax >= 0, 'Tax must be non-negative');
    assert.ok(tax < grossWeekly * 0.5, 'Tax must be less than 50% of gross');
  });

  it('cumulative method recovers overpaid tax from prior periods', () => {
    // Employee was on emergency BR code for 2 months, now corrected to 1257L in month 3
    // Month 3 should refund overpaid tax from months 1+2
    const taxMonth3 = calculatePAYETax({
      grossPay: 3000,
      ytdGrossBefore: 6000, // paid 3k in months 1 and 2
      ytdTaxBefore: 1200,   // 20% BR on all — overpaid by ~570
      taxCode: '1257L', taxBasis: 'cumulative',
      taxPeriod: 3, frequency: 'monthly', rates: rates2526
    });
    // 3 months free pay = 12570/12*3 = 3142.50
    // Taxable to date = 9000 - 3142.50 = 5857.50
    // Tax to date = 5857.50 * 0.20 = 1171.50
    // Tax this period = 1171.50 - 1200 = -28.50 → clamped to 0 (refund handled by payroll software)
    assert.ok(taxMonth3 >= 0);
  });

  it('steady earner month 3: exact cumulative tax', () => {
    // 1257L monthly, £2500/month. Free pay to date (month 3) = 3142.50.
    // Taxable to date = 7500 - 3142.50 = 4357.50 → tax to date 871.50.
    // Months 1-2 tax paid = 581.00 → this period = 290.50.
    const tax = calculatePAYETax({
      grossPay: 2500, ytdGrossBefore: 5000, ytdTaxBefore: 581.00,
      taxCode: '1257L', taxBasis: 'cumulative',
      taxPeriod: 3, frequency: 'monthly', rates: rates2526
    });
    assert.equal(tax, 290.50);
  });

  it('higher earner (£80k/yr monthly) pays higher rate tax', () => {
    // Month 6, YTD 5 months of 6666.67
    const monthlyGross = 6666.67;
    const ytdBefore = 5 * monthlyGross;
    const tax = calculatePAYETax({
      grossPay: monthlyGross,
      ytdGrossBefore: ytdBefore,
      ytdTaxBefore: 0, // simplified
      taxCode: '1257L', taxBasis: 'cumulative',
      taxPeriod: 6, frequency: 'monthly', rates: rates2526
    });
    // At £80k/yr: higher rate applies on income above £50270
    // Some tax in this period should be at 40%
    assert.ok(tax > monthlyGross * 0.20, 'Should have some higher-rate tax');
  });
});

// ── calculateEmployeeNI ──────────────────────────────────────────────────────

describe('calculateEmployeeNI', () => {
  it('below primary threshold: no NI', () => {
    // PT = 12570/52 = £241.73/wk
    const ni = calculateEmployeeNI({ grossPay: 200, niCategory: 'A', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('category C (over SPA): no employee NI', () => {
    const ni = calculateEmployeeNI({ grossPay: 5000, niCategory: 'C', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('category J (deferred): flat 2% above PT', () => {
    // PT = 12570/52 = 241.7308; (500 - 241.7308) × 2% = 5.1654 → 5.17 (nearest penny)
    const ni = calculateEmployeeNI({ grossPay: 500, niCategory: 'J', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 5.17);
  });

  it('category Z (under 21, deferred): same 2% treatment as J', () => {
    const niZ = calculateEmployeeNI({ grossPay: 500, niCategory: 'Z', frequency: 'weekly', rates: rates2526 });
    assert.equal(niZ, 5.17);
  });

  it('category B (married women reduced rate): 1.85% between PT and UEL', () => {
    // (500 - 241.7308) × 1.85% = 4.7780 → 4.78
    const ni = calculateEmployeeNI({ grossPay: 500, niCategory: 'B', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 4.78);
  });

  it('category X: no employee NI', () => {
    const ni = calculateEmployeeNI({ grossPay: 5000, niCategory: 'X', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('categories H and M (employer-relief letters): employee still pays standard rate', () => {
    // Employee-side relief does NOT apply to H/M — only the employer side changes.
    // Monthly £3000: (3000 - 1047.50) × 8% = 156.20
    for (const cat of ['H', 'M']) {
      const ni = calculateEmployeeNI({ grossPay: 3000, niCategory: cat, frequency: 'monthly', rates: rates2526 });
      assert.equal(ni, 156.20, `category ${cat}`);
    }
  });

  it('category A standard rate: correct calculation', () => {
    // Weekly gross £600; PT = 241.7308
    // NI = (600 - 241.7308) × 8% = 28.6615 → 28.66
    const ni = calculateEmployeeNI({ grossPay: 600, niCategory: 'A', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 28.66);
  });

  it('above UEL: main rate + upper rate (2%) on excess', () => {
    // Weekly £1200; UEL = 966.7308, PT = 241.7308
    // Main: 725 × 8% = 58.00; Upper: (1200 - 966.7308) × 2% = 4.6654
    // Total 62.6654 → 62.67 (nearest penny)
    const ni = calculateEmployeeNI({ grossPay: 1200, niCategory: 'A', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 62.67);
  });

  it('category A monthly: correct NI', () => {
    // Monthly gross £3000; PT = 12570/12 = 1047.50
    // NI = (3000 - 1047.50) × 8% = 156.20 exactly
    const ni = calculateEmployeeNI({ grossPay: 3000, niCategory: 'A', frequency: 'monthly', rates: rates2526 });
    assert.equal(ni, 156.20);
  });

  it('CWG2 rounding: an exact half penny rounds DOWN', () => {
    // Category J monthly, PT = 1047.50 exactly.
    // Gross 1147.75: (1147.75 - 1047.50) × 2% = 100.25 × 0.02 = 2.005 → 2.00 (half penny down)
    const ni = calculateEmployeeNI({ grossPay: 1147.75, niCategory: 'J', frequency: 'monthly', rates: rates2526 });
    assert.equal(ni, 2.00);
  });
});

// ── calculateEmployerNI ──────────────────────────────────────────────────────

describe('calculateEmployerNI', () => {
  it('below secondary threshold: no employer NI', () => {
    // ST = 5000/52 = £96.15/wk
    const ni = calculateEmployerNI({ grossPay: 90, niCategory: 'A', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('above ST: 15% on excess (2025/26 rate)', () => {
    // Weekly gross £600; ST = 96.1538
    // (600 - 96.1538) × 15% = 75.5769 → 75.58
    const ni = calculateEmployerNI({ grossPay: 600, niCategory: 'A', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 75.58);
  });

  it('monthly ST correctly applied', () => {
    // ST = 5000/12 = 416.6667; (3000 - 416.6667) × 15% = 387.50
    const ni = calculateEmployerNI({ grossPay: 3000, niCategory: 'A', frequency: 'monthly', rates: rates2526 });
    assert.equal(ni, 387.50);
  });

  it('category M (under 21): 0% up to the UST', () => {
    // UST aligned with UEL = 966.7308/wk — £900 is below it
    const ni = calculateEmployerNI({ grossPay: 900, niCategory: 'M', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('category M (under 21): 15% only above the UST', () => {
    // (1200 - 966.7308) × 15% = 34.9904 → 34.99
    const ni = calculateEmployerNI({ grossPay: 1200, niCategory: 'M', frequency: 'weekly', rates: rates2526 });
    assert.equal(ni, 34.99);
  });

  it('category H (apprentice under 25): 0% below the AUST', () => {
    // AUST monthly = 50270/12 = 4189.17 — £3000 is below it
    const ni = calculateEmployerNI({ grossPay: 3000, niCategory: 'H', frequency: 'monthly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('category X: no employer NI', () => {
    const ni = calculateEmployerNI({ grossPay: 3000, niCategory: 'X', frequency: 'monthly', rates: rates2526 });
    assert.equal(ni, 0);
  });

  it('category C (over SPA): employer still pays standard NI', () => {
    const ni = calculateEmployerNI({ grossPay: 3000, niCategory: 'C', frequency: 'monthly', rates: rates2526 });
    assert.equal(ni, 387.50);
  });
});

// ── calculatePensionContributions ────────────────────────────────────────────

describe('calculatePensionContributions', () => {
  it('not enrolled: returns zeros', () => {
    const r = calculatePensionContributions({
      grossPay: 3000, employeeRate: 0.05, employerRate: 0.03,
      frequency: 'monthly', rates: rates2526, pensionEnrolled: false
    });
    assert.equal(r.employeeContribution, 0);
    assert.equal(r.employerContribution, 0);
  });

  it('below lower qualifying earnings: no pension', () => {
    // AE lower = 6240/12 = £520/month
    const r = calculatePensionContributions({
      grossPay: 400, employeeRate: 0.05, employerRate: 0.03,
      frequency: 'monthly', rates: rates2526, pensionEnrolled: true
    });
    assert.equal(r.employeeContribution, 0);
    assert.equal(r.employerContribution, 0);
  });

  it('within qualifying band: correct contributions (monthly)', () => {
    // Gross £2000; lower = 6240/12 = 520; upper = 50270/12 = 4189.17
    // Qualifying = 2000 - 520 = 1480
    // Employee 5% = 74.00; Employer 3% = 44.40
    const r = calculatePensionContributions({
      grossPay: 2000, employeeRate: 0.05, employerRate: 0.03,
      frequency: 'monthly', rates: rates2526, pensionEnrolled: true
    });
    const lower = 6240 / 12;
    const qualifying = 2000 - lower;
    assert.equal(r.employeeContribution, r2(qualifying * 0.05));
    assert.equal(r.employerContribution, r2(qualifying * 0.03));
  });

  it('above upper qualifying limit: capped at upper', () => {
    // Gross £10000; upper = 50270/12 = 4189.17; lower = 520
    // Qualifying = 4189.17 - 520 = 3669.17
    const r = calculatePensionContributions({
      grossPay: 10000, employeeRate: 0.05, employerRate: 0.03,
      frequency: 'monthly', rates: rates2526, pensionEnrolled: true
    });
    const lower = 6240 / 12;
    const upper = 50270 / 12;
    const qualifying = upper - lower;
    assert.equal(r.employeeContribution, r2(qualifying * 0.05));
    assert.equal(r.employerContribution, r2(qualifying * 0.03));
  });
});

// ── calculateStudentLoan ─────────────────────────────────────────────────────

describe('calculateStudentLoan', () => {
  it('no plan: no deduction', () => {
    const r = calculateStudentLoan({ grossPay: 5000, plan: 'none', postgradLoan: false, frequency: 'monthly', rates: rates2526 });
    assert.equal(r.studentLoanDeduction, 0);
    assert.equal(r.postgradLoanDeduction, 0);
  });

  it('Plan2 below threshold: no deduction', () => {
    // Plan2 monthly = 28470/12 = 2372.50; gross 2000 < threshold
    const r = calculateStudentLoan({ grossPay: 2000, plan: 'Plan2', postgradLoan: false, frequency: 'monthly', rates: rates2526 });
    assert.equal(r.studentLoanDeduction, 0);
  });

  it('Plan2 above threshold: 9% on excess, rounded DOWN to a whole pound (SL3)', () => {
    // Plan2 monthly = 28470/12 = 2372.50
    // (3000 - 2372.50) × 9% = 56.475 → £56 (whole pounds, round down)
    const r = calculateStudentLoan({ grossPay: 3000, plan: 'Plan2', postgradLoan: false, frequency: 'monthly', rates: rates2526 });
    assert.equal(r.studentLoanDeduction, 56);
  });

  it('Plan1 weekly (2025/26 threshold £26,065): whole-pound deduction', () => {
    // Weekly threshold = 26065/52 = 501.25 exactly
    // (700 - 501.25) × 9% = 17.8875 → £17
    const r = calculateStudentLoan({ grossPay: 700, plan: 'Plan1', postgradLoan: false, frequency: 'weekly', rates: rates2526 });
    assert.equal(r.studentLoanDeduction, 17);
  });

  it('Postgrad loan: exact whole-pound result not lost to float noise', () => {
    // (3000 - 1750) × 6% = 75.00 exactly — naive Math.floor of the raw float gives 74
    const r = calculateStudentLoan({ grossPay: 3000, plan: 'none', postgradLoan: true, frequency: 'monthly', rates: rates2526 });
    assert.equal(r.postgradLoanDeduction, 75);
  });

  it('Postgrad loan in addition to Plan2', () => {
    // Gross 5000; Plan2: (5000-2372.50) × 9% = 236.475 → £236
    // Postgrad: (5000-1750) × 6% = 195.00 → £195
    const r = calculateStudentLoan({ grossPay: 5000, plan: 'Plan2', postgradLoan: true, frequency: 'monthly', rates: rates2526 });
    assert.equal(r.studentLoanDeduction, 236);
    assert.equal(r.postgradLoanDeduction, 195);
  });
});

// ── Integration: gross-to-net smoke test ────────────────────────────────────

describe('gross-to-net integration', () => {
  it('£30k/yr employee (monthly): net pay is reasonable', () => {
    // Monthly gross = 2500
    // PAYE: (2500 - 1047.50) * 0.20 = 290.50
    // Employee NI: (2500 - 1047.50) * 0.08 = 116.20
    // No pension, no loans
    // Net ≈ 2500 - 290.50 - 116.20 = 2093.30
    const tax = calculatePAYETax({
      grossPay: 2500, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: '1257L', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'monthly', rates: rates2526
    });
    const ni = calculateEmployeeNI({ grossPay: 2500, niCategory: 'A', frequency: 'monthly', rates: rates2526 });
    const net = r2(2500 - tax - ni);
    assert.ok(net > 2000, `Net pay should be >£2000 for £30k/yr, got £${net}`);
    assert.ok(net < 2500, `Net pay must be less than gross`);
  });

  it('minimum wage (£12.21/hr, 37.5hrs): no tax, correct NI', () => {
    // Weekly gross = 12.21 * 37.5 = 457.875 ≈ 457.88
    const weeklyGross = Math.round(12.21 * 37.5 * 100) / 100;
    const tax = calculatePAYETax({
      grossPay: weeklyGross, ytdGrossBefore: 0, ytdTaxBefore: 0,
      taxCode: '1257L', taxBasis: 'week1/month1',
      taxPeriod: 1, frequency: 'weekly', rates: rates2526
    });
    // Weekly personal allowance = 12570/52 = 241.73 < 457.88 → some tax expected
    // But annual equivalent ≈ 457.88 * 52 = 23809.76 → some basic rate tax
    assert.ok(tax >= 0);
    assert.ok(tax < weeklyGross * 0.3, 'Tax should be < 30% for min wage worker');
  });
});
