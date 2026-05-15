'use strict';

/**
 * payrollCalculationService.js
 *
 * Full UK gross-to-net PAYE payroll calculation engine.
 *
 * Calculates for each employee, per pay period:
 *  - Gross pay (from attendance records + manual adjustments)
 *  - PAYE income tax (cumulative or week1/month1 basis)
 *  - Employee National Insurance (Class 1)
 *  - Employer National Insurance (Class 1)
 *  - Auto-enrolment pension contributions (employee + employer)
 *  - Student / postgrad loan deductions
 *  - Net pay
 *
 * All monetary arithmetic is performed in pence (integers) then
 * converted back to pounds to avoid floating-point drift.
 *
 * References:
 *  HMRC CWG2 — https://www.gov.uk/government/publications/cwg2-further-guide-to-paye-and-national-insurance-contributions
 *  HMRC NI thresholds — https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2025-to-2026
 */

const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Decimal128 / string / number to a plain JS number. */
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
  return Number(v) || 0;
}

/**
 * Round a decimal amount to the nearest penny (2 dp), using
 * HMRC-standard "round half up" for tax, and "truncate" for NI.
 */
function roundHalfUp(n) {
  return Math.round(n * 100) / 100;
}

function truncatePence(n) {
  return Math.trunc(n * 100) / 100;
}

/**
 * Scale an annual threshold to the correct per-period amount.
 * HMRC periods: weekly=1/52, fortnightly=2/52, monthly=1/12.
 */
function annualToPeriod(annual, frequency) {
  if (frequency === 'monthly')     return annual / 12;
  if (frequency === 'fortnightly') return (annual * 2) / 52;
  return annual / 52; // weekly
}

/**
 * Returns number of periods in the tax year for the given frequency and period number.
 * taxPeriod: week number (1-52) or month number (1-12).
 */
function periodsInYear(frequency) {
  if (frequency === 'monthly')     return 12;
  if (frequency === 'fortnightly') return 26;
  return 52;
}

// ---------------------------------------------------------------------------
// Tax code parsing
// ---------------------------------------------------------------------------

/**
 * Parse a tax code into its numeric allowance and modifier flags.
 *
 * Returns:
 *  { freePayAnnual, isK, isBR, isD0, isD1, isNT, isOther }
 *
 * Tax code formats (England/Wales/NI):
 *  1257L  → free pay = £12,570/yr
 *  BR     → basic rate on all income, no free pay
 *  D0     → higher rate on all income
 *  D1     → additional rate on all income
 *  NT     → no tax
 *  K1234  → negative free pay (add to gross before tax)
 *  0T     → zero personal allowance
 *  M/N suffix → Marriage Allowance (adjust numeric by ±1250, already encoded)
 */
function parseTaxCode(rawCode) {
  const code = (rawCode || '1257L').trim().toUpperCase().replace(/\s/g, '');

  if (code === 'NT') return { freePayAnnual: 0, isBR: false, isD0: false, isD1: false, isNT: true, isK: false, isOther: false };
  if (code === 'BR') return { freePayAnnual: 0, isBR: true,  isD0: false, isD1: false, isNT: false, isK: false, isOther: false };
  if (code === 'D0') return { freePayAnnual: 0, isBR: false, isD0: true,  isD1: false, isNT: false, isK: false, isOther: false };
  if (code === 'D1') return { freePayAnnual: 0, isBR: false, isD0: false, isD1: true,  isNT: false, isK: false, isOther: false };
  if (code === '0T') return { freePayAnnual: 0, isBR: false, isD0: false, isD1: false, isNT: false, isK: false, isOther: false };

  // K code: negative allowance
  const kMatch = code.match(/^K(\d+)$/);
  if (kMatch) {
    return { freePayAnnual: -Number(kMatch[1]) * 10, isBR: false, isD0: false, isD1: false, isNT: false, isK: true, isOther: false };
  }

  // Standard L/M/N/T/etc numeric codes
  const stdMatch = code.match(/^(\d+)[LMNTW]?$/);
  if (stdMatch) {
    return { freePayAnnual: Number(stdMatch[1]) * 10, isBR: false, isD0: false, isD1: false, isNT: false, isK: false, isOther: false };
  }

  // Unknown — treat as 0T (safest: no allowance, all taxed)
  logger.warn(`[payrollCalculationService] Unrecognised tax code '${rawCode}' — treating as 0T`);
  return { freePayAnnual: 0, isBR: false, isD0: false, isD1: false, isNT: false, isK: false, isOther: true };
}

// ---------------------------------------------------------------------------
// PAYE income tax calculation
// ---------------------------------------------------------------------------

/**
 * Calculate PAYE tax due this period.
 *
 * Implements the HMRC "Free Pay" cumulative method (CWG2 Appendix 1) and
 * the Week 1 / Month 1 non-cumulative method.
 *
 * @param {object} p
 *   grossPay        {number} — taxable gross pay this period (£)
 *   ytdGrossBefore  {number} — YTD taxable gross BEFORE this period (£)
 *   ytdTaxBefore    {number} — YTD tax paid BEFORE this period (£)
 *   taxCode         {string} — e.g. '1257L'
 *   taxBasis        {string} — 'cumulative' | 'week1/month1'
 *   taxPeriod       {number} — week/month number within the tax year (1-based)
 *   frequency       {string} — 'weekly' | 'fortnightly' | 'monthly'
 *   rates           {object} — payrollTaxRates document
 *
 * @returns {number} tax to deduct this period (£, ≥0)
 */
function calculatePAYETax({ grossPay, ytdGrossBefore, ytdTaxBefore, taxCode, taxBasis, taxPeriod, frequency, rates }) {
  const { freePayAnnual, isBR, isD0, isD1, isNT, isK } = parseTaxCode(taxCode);

  if (isNT) return 0;

  const {
    personalAllowance, basicRateLimit, higherRateThreshold,
    additionalRateThreshold, basicRate, higherRate, additionalRate
  } = rates;

  /**
   * Calculate tax on a given cumulative taxable-to-date figure.
   * Uses the stepped UK rate bands.
   */
  function taxOnCumulative(taxable) {
    if (taxable <= 0) return 0;

    if (isBR) return roundHalfUp(taxable * basicRate);
    if (isD0) return roundHalfUp(taxable * higherRate);
    if (isD1) return roundHalfUp(taxable * additionalRate);

    let tax = 0;
    // Basic rate band
    const basicBand = basicRateLimit;
    const taxedAtBasic = Math.min(taxable, basicBand);
    tax += taxedAtBasic * basicRate;

    // Higher rate band
    if (taxable > basicBand) {
      const higherBand = additionalRateThreshold - basicRateLimit - personalAllowance;
      const taxedAtHigher = Math.min(taxable - basicBand, higherBand);
      tax += taxedAtHigher * higherRate;
    }

    // Additional rate
    if (taxable > (additionalRateThreshold - personalAllowance)) {
      const taxedAtAdditional = taxable - (additionalRateThreshold - personalAllowance);
      if (taxedAtAdditional > 0) tax += taxedAtAdditional * additionalRate;
    }

    return roundHalfUp(tax);
  }

  if (taxBasis === 'week1/month1') {
    // Non-cumulative: calculate tax for this period in isolation
    const periodFreePay = annualToPeriod(freePayAnnual, frequency);
    let taxableThisPeriod = isK
      ? grossPay + Math.abs(periodFreePay)
      : grossPay - periodFreePay;
    taxableThisPeriod = Math.max(0, taxableThisPeriod);

    const annualisedTaxable = taxableThisPeriod * periodsInYear(frequency);
    const annualisedTax = taxOnCumulative(annualisedTaxable);
    const periodTax = annualisedTax / periodsInYear(frequency);
    return Math.max(0, roundHalfUp(periodTax));
  }

  // ── Cumulative method ─────────────────────────────────────────────────────
  // Free pay to date = annual free pay × (taxPeriod / periodsInYear)
  const freePayToDate = isK
    ? 0  // K codes: no free pay (the offset is added to gross instead)
    : freePayAnnual * (taxPeriod / periodsInYear(frequency));

  const grossToDate = ytdGrossBefore + grossPay;

  let taxableToDate;
  if (isK) {
    // K code: add the annual K offset proportionally to gross
    const kOffset = Math.abs(freePayAnnual) * (taxPeriod / periodsInYear(frequency));
    taxableToDate = grossToDate + kOffset;
  } else {
    taxableToDate = grossToDate - freePayToDate;
  }

  taxableToDate = Math.max(0, taxableToDate);
  const taxToDate = taxOnCumulative(taxableToDate);
  const taxThisPeriod = taxToDate - ytdTaxBefore;

  return Math.max(0, roundHalfUp(taxThisPeriod));
}

// ---------------------------------------------------------------------------
// National Insurance calculation
// ---------------------------------------------------------------------------

/**
 * Calculate employee Class 1 NI contribution for a pay period.
 *
 * @param {object} p
 *   grossPay    {number} — gross pay this period (£) — NOT reduced for pension
 *   niCategory  {string} — A, B, C, H, J, M, Z
 *   frequency   {string}
 *   rates       {object}
 *
 * @returns {number} employee NI this period (£, ≥0)
 *
 * Category notes:
 *   A — standard (most employees)
 *   B — married women / widows with reduced rate election (5.85% main, 2% upper)
 *   C — over State Pension Age: no employee NI
 *   H — apprentices under 25: no employee NI between ST and UEL
 *   J — deferred (employees with another job already paying NI): 2% flat above PT
 *   M — under 21: same as A currently
 *   Z — under 21, deferred: 0% between ST and UEL, 2% above
 */
function calculateEmployeeNI({ grossPay, niCategory, frequency, rates }) {
  const { niLEL, niPT, niUEL, niEmployeeMain, niEmployeeUpper } = rates;

  const pt  = annualToPeriod(niPT,  frequency);
  const uel = annualToPeriod(niUEL, frequency);

  const cat = (niCategory || 'A').toUpperCase();

  // Categories with no employee NI at all
  if (cat === 'C') return 0;

  // Category J (deferred): flat 2% above PT
  if (cat === 'J' || cat === 'Z') {
    if (grossPay <= pt) return 0;
    return Math.max(0, truncatePence((grossPay - pt) * niEmployeeUpper));
  }

  // Category B (reduced rate): ~5.85% main, 2% upper
  // HMRC 2025/26: 5.85% between PT and UEL, 2% above UEL
  const mainRate  = cat === 'B' ? 0.0585 : niEmployeeMain;
  const upperRate = niEmployeeUpper;

  if (grossPay <= pt)  return 0;

  let ni = 0;
  // Main rate band: PT to UEL
  const mainBandEarnings = Math.min(grossPay, uel) - pt;
  if (mainBandEarnings > 0) ni += mainBandEarnings * mainRate;

  // Upper rate: above UEL
  if (grossPay > uel) {
    ni += (grossPay - uel) * upperRate;
  }

  return Math.max(0, truncatePence(ni));
}

/**
 * Calculate employer Class 1 NI for a pay period.
 *
 * @param {object} p
 *   grossPay  {number} — gross pay this period (£)
 *   frequency {string}
 *   rates     {object}
 *
 * @returns {number} employer NI this period (£, ≥0)
 *
 * Note: Employer NI applies above the Secondary Threshold (ST) at 13.8%.
 * The Employment Allowance (up to £10,500 for 2025/26) is applied at the
 * company level, not per-employee — so it is NOT deducted here.
 * The journal posting service should handle EA offset separately.
 */
function calculateEmployerNI({ grossPay, frequency, rates }) {
  const { niST, niEmployerRate } = rates;
  const st = annualToPeriod(niST, frequency);

  if (grossPay <= st) return 0;
  return Math.max(0, truncatePence((grossPay - st) * niEmployerRate));
}

// ---------------------------------------------------------------------------
// Pension (auto-enrolment qualifying earnings)
// ---------------------------------------------------------------------------

/**
 * Calculate employee and employer pension contributions.
 *
 * Uses the "qualifying earnings" basis:
 *   contributable = MIN(grossPay, aeUpper) - aeLower  [per period]
 *   employee_contribution = contributable × employeeRate
 *   employer_contribution = contributable × employerRate
 *
 * If salarySacrifice is true the employee contribution is deducted from
 * taxable gross BEFORE PAYE is calculated (caller must do this).
 *
 * @param {object} p
 *   grossPay           {number}
 *   employeeRate       {number} — fraction e.g. 0.05
 *   employerRate       {number} — fraction e.g. 0.03
 *   frequency          {string}
 *   rates              {object}
 *   pensionEnrolled    {boolean}
 *
 * @returns {{ employeeContribution, employerContribution }}
 */
function calculatePensionContributions({ grossPay, employeeRate, employerRate, frequency, rates, pensionEnrolled }) {
  if (!pensionEnrolled) return { employeeContribution: 0, employerContribution: 0 };

  const { aeQualifyingLower, aeQualifyingUpper } = rates;
  const lower = annualToPeriod(aeQualifyingLower, frequency);
  const upper = annualToPeriod(aeQualifyingUpper, frequency);

  const qualifying = Math.max(0, Math.min(grossPay, upper) - lower);

  const employeeContribution = roundHalfUp(qualifying * (employeeRate || 0));
  const employerContribution  = roundHalfUp(qualifying * (employerRate  || 0));

  return { employeeContribution, employerContribution };
}

// ---------------------------------------------------------------------------
// Student / postgrad loan
// ---------------------------------------------------------------------------

/**
 * Calculate student and postgrad loan deductions for a pay period.
 *
 * @param {object} p
 *   grossPay     {number}
 *   plan         {string} — 'none' | 'Plan1' | 'Plan2' | 'Plan4' | 'Postgrad'
 *   postgradLoan {boolean}
 *   frequency    {string}
 *   rates        {object}
 *
 * @returns {{ studentLoanDeduction, postgradLoanDeduction }}
 */
function calculateStudentLoan({ grossPay, plan, postgradLoan, frequency, rates }) {
  const {
    studentLoanPlan1Threshold, studentLoanPlan2Threshold,
    studentLoanPlan4Threshold, studentLoanPostgradThreshold,
    studentLoanRate, postgradLoanRate
  } = rates;

  let studentLoanDeduction = 0;
  let postgradLoanDeduction = 0;

  const thresholdMap = {
    Plan1: studentLoanPlan1Threshold,
    Plan2: studentLoanPlan2Threshold,
    Plan4: studentLoanPlan4Threshold
  };

  if (plan && plan !== 'none' && thresholdMap[plan] != null) {
    const threshold = annualToPeriod(thresholdMap[plan], frequency);
    if (grossPay > threshold) {
      studentLoanDeduction = truncatePence((grossPay - threshold) * (studentLoanRate || 0.09));
    }
  }

  if (postgradLoan && studentLoanPostgradThreshold != null) {
    const pgThreshold = annualToPeriod(studentLoanPostgradThreshold, frequency);
    if (grossPay > pgThreshold) {
      postgradLoanDeduction = truncatePence((grossPay - pgThreshold) * (postgradLoanRate || 0.06));
    }
  }

  return { studentLoanDeduction, postgradLoanDeduction };
}

// ---------------------------------------------------------------------------
// Gross pay from attendance
// ---------------------------------------------------------------------------

/**
 * Aggregate gross pay for an employee from their approved attendance records
 * within the payroll period.
 *
 * Uses the same logic as the weekly payroll view: hours × hourlyRate for
 * hourly employees, dayRate per day for daily-rated employees.
 *
 * @param {mongoose.Types.ObjectId|string} employeeId
 * @param {Date} periodStart
 * @param {Date} periodEnd
 * @param {object} employee — populated employee document
 *
 * @returns {number} gross pay in £
 */
async function getGrossPayFromAttendance(employeeId, periodStart, periodEnd, employee) {
  const AttendanceModel = mdb.INTERNAL?.attendance;
  if (!AttendanceModel) throw new Error('INTERNAL.attendance model not available');

  const records = await AttendanceModel.find({
    employeeId,
    date: { $gte: periodStart, $lte: periodEnd },
    status: 'approved',
    type: { $in: ['work', 'training'] }
  }).lean();

  let total = 0;

  for (const rec of records) {
    const hours    = toNum(rec.hoursWorked);
    const dayRate  = toNum(rec.dayRate);
    const payRate  = toNum(rec.payRate);
    const overtime = toNum(rec.overtimeHours);
    const otRate   = toNum(rec.overtimeRate);

    if (dayRate > 0) {
      total += dayRate;
    } else {
      const rate = payRate > 0 ? payRate : toNum(employee.hourlyRate);
      total += hours * rate;
      if (overtime > 0 && otRate > 0) total += overtime * otRate;
    }
  }

  return roundHalfUp(total);
}

// ---------------------------------------------------------------------------
// Per-employee entry computation
// ---------------------------------------------------------------------------

/**
 * Compute the full gross-to-net payroll entry for a single employee.
 *
 * @param {object} p
 *   employee         {object} — lean employee document with payroll subdoc
 *   grossPayManual   {number} — manual adjustment (bonus, correction, etc.)
 *   taxPeriod        {number} — week or month number (1-based) within tax year
 *   frequency        {string}
 *   taxRates         {object} — payrollTaxRates document
 *   config           {object} — payrollConfig document
 *   periodStart      {Date}
 *   periodEnd        {Date}
 *   paymentDate      {Date}
 *
 * @returns {object} — all fields needed to create a payrollEntry document
 */
async function computeEntryForEmployee({ employee, grossPayManual = 0, taxPeriod, frequency, taxRates, config, periodStart, periodEnd, paymentDate }) {
  const payroll = employee.payroll || {};

  // ── Gross from attendance ─────────────────────────────────────────────────
  const grossPayFromAttendance = await getGrossPayFromAttendance(employee._id, periodStart, periodEnd, employee);
  const grossPay = roundHalfUp(grossPayFromAttendance + grossPayManual);

  // ── Pension rates ─────────────────────────────────────────────────────────
  const pensionEnrolled    = !!payroll.pensionEnrolled;
  const salarySacrifice    = !!payroll.salarySacrifice;
  const employeePensionRate = toNum(payroll.employeePensionRate) > 0
    ? toNum(payroll.employeePensionRate) / 100
    : toNum(config.defaultEmployeePensionRate) / 100;
  const employerPensionRate = toNum(payroll.employerPensionRate) > 0
    ? toNum(payroll.employerPensionRate) / 100
    : toNum(config.defaultEmployerPensionRate) / 100;

  // ── Pension contributions ─────────────────────────────────────────────────
  const { employeeContribution: employeePension, employerContribution: employerPension } =
    calculatePensionContributions({ grossPay, employeeRate: employeePensionRate, employerRate: employerPensionRate, frequency, rates: taxRates, pensionEnrolled });

  // ── Taxable gross (salary sacrifice reduces taxable) ─────────────────────
  const taxableGross = salarySacrifice
    ? Math.max(0, grossPay - employeePension)
    : grossPay;

  // ── PAYE tax ──────────────────────────────────────────────────────────────
  const ytdGrossBefore = toNum(payroll.ytdGrossPay);
  const ytdTaxBefore   = toNum(payroll.ytdTaxPaid);
  const taxCode  = payroll.taxCode  || '1257L';
  const taxBasis = payroll.taxBasis || 'cumulative';

  const taxDeducted = calculatePAYETax({
    grossPay: taxableGross,
    ytdGrossBefore,
    ytdTaxBefore,
    taxCode,
    taxBasis,
    taxPeriod,
    frequency,
    rates: taxRates
  });

  // ── Employee NI ───────────────────────────────────────────────────────────
  const niCategory = payroll.niCategory || 'A';
  const employeeNI = calculateEmployeeNI({ grossPay, niCategory, frequency, rates: taxRates });

  // ── Employer NI ───────────────────────────────────────────────────────────
  const employerNI = calculateEmployerNI({ grossPay, frequency, rates: taxRates });

  // ── Student loans ─────────────────────────────────────────────────────────
  const { studentLoanDeduction, postgradLoanDeduction } = calculateStudentLoan({
    grossPay,
    plan:        payroll.studentLoanPlan || 'none',
    postgradLoan: !!payroll.postgradLoan,
    frequency,
    rates: taxRates
  });

  // ── Net pay ───────────────────────────────────────────────────────────────
  const netPay = roundHalfUp(
    grossPay
    - taxDeducted
    - employeeNI
    - employeePension
    - studentLoanDeduction
    - postgradLoanDeduction
  );

  // ── YTD after this run ────────────────────────────────────────────────────
  const ytdGrossPayAfter   = roundHalfUp(ytdGrossBefore + grossPay);
  const ytdTaxPaidAfter    = roundHalfUp(ytdTaxBefore   + taxDeducted);
  const ytdEmployeeNIAfter = roundHalfUp(toNum(payroll.ytdEmployeeNI) + employeeNI);
  const ytdEmployerNIAfter = roundHalfUp(toNum(payroll.ytdEmployerNI) + employerNI);

  return {
    employeeId:              employee._id,
    paymentDate,
    grossPay,
    grossPayFromAttendance,
    grossPayManualAdjustment: grossPayManual,
    taxableGross,
    taxCode,
    taxBasis,
    taxDeducted,
    niCategory,
    employeeNI,
    employerNI,
    employeePensionRate: roundHalfUp(employeePensionRate * 100),
    employerPensionRate: roundHalfUp(employerPensionRate * 100),
    employeePension,
    employerPension,
    salarySacrifice,
    studentLoanPlan:       payroll.studentLoanPlan || 'none',
    studentLoanDeduction,
    postgradLoanDeduction,
    netPay,
    ytdGrossPayAfter,
    ytdTaxPaidAfter,
    ytdEmployeeNIAfter,
    ytdEmployerNIAfter,
    overrideFlags: []
  };
}

// ---------------------------------------------------------------------------
// Process a full payroll run
// ---------------------------------------------------------------------------

/**
 * Process all employees in a payroll run.
 *
 * Loads the run, fetches tax rates + config, iterates active employees,
 * computes gross-to-net for each, saves/replaces payrollEntry documents,
 * and updates run.totals.
 *
 * Does NOT lock the run — caller must call lock separately.
 *
 * @param {string} runId — UUID or ObjectId of the payrollRun
 * @returns {object} updated payrollRun document
 */
async function processPayrollRun(runId) {
  const PayrollRun   = mdb.INTERNAL?.payrollRun;
  const PayrollEntry = mdb.INTERNAL?.payrollEntry;
  const PayrollTaxRates = mdb.INTERNAL?.payrollTaxRates;
  const PayrollConfig   = mdb.INTERNAL?.payrollConfig;
  const Employee        = mdb.INTERNAL?.employee;

  if (!PayrollRun || !PayrollEntry || !PayrollTaxRates || !PayrollConfig || !Employee) {
    throw new Error('Required INTERNAL models not available — database may not be connected');
  }

  // Load the run
  const run = await PayrollRun.findOne({ $or: [{ uuid: runId }, { _id: runId }] }).lean();
  if (!run) throw new Error(`payrollRun not found: ${runId}`);
  if (run.status === 'submitted') throw new Error('Cannot recalculate a submitted payroll run');

  // Load tax rates for the tax year
  const taxRates = await PayrollTaxRates.findOne({ taxYear: run.taxYear }).lean();
  if (!taxRates) throw new Error(`No tax rates found for tax year ${run.taxYear}. Run scripts/seed-payroll-tax-rates.js`);

  // Load config
  const config = await PayrollConfig.findOne().lean();
  if (!config) throw new Error('Payroll configuration not found. Please configure payroll settings first.');

  // Determine tax period number
  const taxPeriod = run.taxWeek || run.taxMonth;
  if (!taxPeriod) throw new Error('payrollRun must have taxWeek or taxMonth set');

  // Load all active employees
  const employees = await Employee.find({ status: 'active' }).lean();

  const savedEntryIds = [];
  const totals = { grossPay: 0, taxDeducted: 0, employeeNI: 0, employerNI: 0, employeePension: 0, employerPension: 0, netPay: 0, studentLoan: 0 };

  for (const employee of employees) {
    try {
      // Check for existing manual adjustments on a prior entry for this run
      const existingEntry = await PayrollEntry.findOne({ runId: run._id, employeeId: employee._id }).lean();
      const grossPayManual = existingEntry
        ? toNum(existingEntry.grossPayManualAdjustment)
        : 0;

      const entryData = await computeEntryForEmployee({
        employee,
        grossPayManual,
        taxPeriod,
        frequency: run.frequency,
        taxRates,
        config,
        periodStart: run.periodStart,
        periodEnd:   run.periodEnd,
        paymentDate: run.paymentDate
      });

      // Preserve any manual override flags from existing entry
      if (existingEntry && existingEntry.overrideFlags && existingEntry.overrideFlags.length > 0) {
        for (const field of existingEntry.overrideFlags) {
          if (existingEntry[field] !== undefined) {
            entryData[field] = existingEntry[field];
          }
        }
        entryData.overrideFlags = existingEntry.overrideFlags;
      }

      const saved = await PayrollEntry.findOneAndUpdate(
        { runId: run._id, employeeId: employee._id },
        { $set: { ...entryData, runId: run._id, uuid: existingEntry?.uuid ?? undefined } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      savedEntryIds.push(saved._id);

      totals.grossPay       += toNum(entryData.grossPay);
      totals.taxDeducted    += toNum(entryData.taxDeducted);
      totals.employeeNI     += toNum(entryData.employeeNI);
      totals.employerNI     += toNum(entryData.employerNI);
      totals.employeePension += toNum(entryData.employeePension);
      totals.employerPension += toNum(entryData.employerPension);
      totals.netPay         += toNum(entryData.netPay);
      totals.studentLoan    += toNum(entryData.studentLoanDeduction) + toNum(entryData.postgradLoanDeduction);
    } catch (err) {
      logger.error(`[payrollCalculationService] Failed for employee ${employee._id}: ${err.message}`, { stack: err.stack });
      throw err;
    }
  }

  // Update the run's entry list and totals
  const updatedRun = await PayrollRun.findOneAndUpdate(
    { _id: run._id },
    {
      $set: {
        entries: savedEntryIds,
        'totals.grossPay':        roundHalfUp(totals.grossPay),
        'totals.taxDeducted':     roundHalfUp(totals.taxDeducted),
        'totals.employeeNI':      roundHalfUp(totals.employeeNI),
        'totals.employerNI':      roundHalfUp(totals.employerNI),
        'totals.employeePension': roundHalfUp(totals.employeePension),
        'totals.employerPension': roundHalfUp(totals.employerPension),
        'totals.netPay':          roundHalfUp(totals.netPay),
        'totals.studentLoan':     roundHalfUp(totals.studentLoan)
      }
    },
    { new: true }
  );

  logger.info(`[payrollCalculationService] Run ${run.uuid} processed — ${employees.length} employees, gross £${totals.grossPay.toFixed(2)}`);
  return updatedRun;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Exported for direct use in controller and tests
  calculatePAYETax,
  calculateEmployeeNI,
  calculateEmployerNI,
  calculatePensionContributions,
  calculateStudentLoan,
  computeEntryForEmployee,
  processPayrollRun,
  getGrossPayFromAttendance,
  // Exported for testing helpers
  parseTaxCode,
  annualToPeriod,
  periodsInYear,
  toNum
};
