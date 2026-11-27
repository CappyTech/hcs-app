// Pay rates from Staffology (services/staffologyModeService.js).
//
// In Staffology mode payroll is run in Staffology, so a linked employee's pay
// rate there is the one that counts. This copies it onto the hcs-app employee
// (INTERNAL), so everything that prices attendance from employee.hourlyRate
// (Job Register labour, the pay vs attendance comparison, attendance pay)
// uses the same rate as payroll.
//
// Linking: an employee is linked when employee.payroll.payrollId equals a
// Staffology PayrollCode (same matching as payrollProviderService).
//
// Mapping (rateFromStaffology):
//   BaseHourlyRate set → definedRate 'hourly', hourlyRate = BaseHourlyRate
//   otherwise          → definedRate 'daily',  dailyRate  = BaseDailyRate
// The hourly rate wins whatever the PayBasis, because it is what attendance
// logged in hours is priced at (Job Register labour, pay vs attendance), and
// the validate hook can only work an hourly rate out of a daily one when
// contract.hoursPerWeek is set. Days paid by day rate carry their own
// attendance dayRate, so they don't depend on the employee's dailyRate. With no
// usable rate (none, or 0) the employee is left alone: a 0 never replaces a
// real rate. The employee's pre('validate') hook works the other rates out
// from the defined one, so the save goes through the Mongoose document.
//
// Runs: after linking one employee, every hour (jobRegistry,
// 'staffology-rate-sync'), and from the button on /payroll/staffology/employees.
// The STAFFOLOGY database is only ever read.
import mongoose from 'mongoose';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { isStaffologyMode } from '../../services/staffologyModeService.js';

export const RATE_SOURCE = 'staffology';
/** Shown next to rate fields that come from Staffology. */
export const LOCK_NOTE = 'From Staffology';
/** The rate fields hand edits must not touch while they come from Staffology. */
export const RATE_FIELDS = ['definedRate', 'hourlyRate', 'dailyRate', 'weeklyRate', 'monthlyRate', 'yearlyRate'];

const DECIMALS = { hourlyRate: 4, dailyRate: 2 };

export const normCode = (c) => (c == null ? '' : String(c).trim().toLowerCase());

/** Decimal128 / string / number → number (null when empty or not a number). */
export function d2n(v) {
  if (v == null || v === '') return null;
  const n = Number(typeof v === 'object' && v.toString ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
}

const positive = (v) => {
  const n = d2n(v);
  return n != null && n > 0 ? n : null;
};

const round = (n, dp) => Number(n.toFixed(dp));

/**
 * The rate a Staffology employee should give the hcs-app employee, or null
 * when there is no usable rate (pure).
 *
 * @param {object} pe - Staffology payroll employee (PayBasis, BaseHourlyRate, BaseDailyRate)
 * @returns {{ definedRate: 'hourly'|'daily', field: 'hourlyRate'|'dailyRate', value: number }|null}
 */
export function rateFromStaffology(pe) {
  if (!pe) return null;
  const daily = positive(pe.BaseDailyRate);
  const hourly = positive(pe.BaseHourlyRate);
  if (hourly != null) {
    return { definedRate: 'hourly', field: 'hourlyRate', value: round(hourly, DECIMALS.hourlyRate) };
  }
  if (daily != null) {
    return { definedRate: 'daily', field: 'dailyRate', value: round(daily, DECIMALS.dailyRate) };
  }
  return null;
}

/**
 * What to change on an hcs-app employee to match Staffology, or null when
 * nothing needs changing (pure).
 *
 * - no usable Staffology rate → null (the employee is left alone);
 * - same defined rate and value, already marked as from Staffology → null;
 * - same rate but not yet marked → { ..., provenanceOnly: true }.
 *
 * @param {object} employee - hcs-app employee (definedRate, hourlyRate, dailyRate, payroll.rateSource)
 * @param {object} pe - Staffology payroll employee
 */
export function planRateUpdate(employee, pe) {
  const target = rateFromStaffology(pe);
  if (!target || !employee) return null;
  const current = d2n(employee[target.field]);
  const sameRate = (employee.definedRate || 'weekly') === target.definedRate
    && current != null
    && round(current, DECIMALS[target.field]) === target.value;
  if (sameRate) {
    return employee.payroll?.rateSource === RATE_SOURCE ? null : { ...target, provenanceOnly: true };
  }
  return { ...target, provenanceOnly: false };
}

/**
 * Should this employee's rate fields be read-only? Yes in Staffology mode
 * when they are linked to a Staffology record that has a usable rate (the
 * ones the sync would overwrite). Pure apart from the mode switch.
 */
export function ratesLockedFor(pe, staffologyMode = isStaffologyMode()) {
  return Boolean(staffologyMode && rateFromStaffology(pe));
}

/** Apply a plan to a Mongoose employee document (no save). */
export function applyPlan(doc, plan, now = new Date()) {
  if (!plan.provenanceOnly) {
    doc.definedRate = plan.definedRate;
    doc[plan.field] = mongoose.Types.Decimal128.fromString(plan.value.toFixed(DECIMALS[plan.field]));
  }
  doc.set('payroll.rateSource', RATE_SOURCE);
  doc.set('payroll.ratesSyncedAt', now);
  return doc;
}

// ── Database ─────────────────────────────────────────────────────────────────

const models = () => ({
  Employee: mdb.INTERNAL?.employee || null,
  PayrollEmployee: mdb.STAFFOLOGY?.payrollemployee || null,
});

/** The Staffology record linked to an hcs-app employee (lean), or null. */
export async function payrollEmployeeFor(employee) {
  const { PayrollEmployee } = models();
  const code = normCode(employee?.payroll?.payrollId);
  if (!PayrollEmployee || !code) return null;
  const exact = await PayrollEmployee.findOne({ PayrollCode: String(employee.payroll.payrollId).trim() }).lean();
  if (exact) return exact;
  // Same normalisation as payrollProviderService (case-insensitive).
  const all = await PayrollEmployee.find({}).select('PayrollCode PayBasis BaseHourlyRate BaseDailyRate').lean();
  return all.find((pe) => normCode(pe.PayrollCode) === code) || null;
}

/** Are this employee's rates locked to Staffology right now? */
export async function ratesLocked(employee) {
  if (!isStaffologyMode() || !employee?.payroll?.payrollId) return false;
  try {
    return ratesLockedFor(await payrollEmployeeFor(employee), true);
  } catch (err) {
    logger.warn(`[staffologyRateSync] lock check failed: ${err.message}`);
    return false;
  }
}

/**
 * Bring linked employees' rates in line with Staffology. Only in Staffology
 * mode. Pass employeeUuid to do one employee (after linking).
 *
 * @returns {Promise<{checked:number, updated:number, skipped:number, failed:number, reason?:string}>}
 */
export async function syncRates({ employeeUuid = null } = {}) {
  const summary = { checked: 0, updated: 0, skipped: 0, failed: 0 };
  if (!isStaffologyMode()) return { ...summary, reason: 'Not in Staffology mode' };
  const { Employee, PayrollEmployee } = models();
  if (!Employee || !PayrollEmployee) return { ...summary, reason: 'Staffology data is not available' };

  const filter = { 'payroll.payrollId': { $nin: [null, ''] } };
  if (employeeUuid) filter.uuid = String(employeeUuid);
  const [employees, payrollEmployees] = await Promise.all([
    Employee.find(filter),
    PayrollEmployee.find({}).select('PayrollCode PayBasis BaseHourlyRate BaseDailyRate').lean(),
  ]);
  const byCode = new Map();
  for (const pe of payrollEmployees) {
    const code = normCode(pe.PayrollCode);
    if (code && !byCode.has(code)) byCode.set(code, pe);
  }

  const now = new Date();
  for (const doc of employees) {
    const pe = byCode.get(normCode(doc.payroll?.payrollId));
    if (!pe) continue; // not linked to anyone Staffology knows
    summary.checked += 1;
    const plan = planRateUpdate(doc, pe);
    if (!plan) { summary.skipped += 1; continue; }
    try {
      applyPlan(doc, plan, now);
      await doc.save();
      summary.updated += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn(`[staffologyRateSync] employee ${doc.uuid}: ${err.message}`);
    }
  }
  logger.info(`[staffologyRateSync] ${employeeUuid ? 'one employee' : 'all linked'}: checked ${summary.checked}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed}`);
  return summary;
}

/** Plain words for a summary, for a flash message (pure). */
export function describeSummary(s) {
  if (s?.reason) return `Rates not updated: ${s.reason.toLowerCase()}.`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [`Checked ${plural(s.checked, 'linked employee')}`, `${s.updated} updated`, `${s.skipped} already up to date or with no rate in Staffology`];
  if (s.failed) parts.push(`${s.failed} could not be saved (see the log)`);
  return `${parts.join(', ')}.`;
}

export default {
  RATE_SOURCE,
  RATE_FIELDS,
  LOCK_NOTE,
  rateFromStaffology,
  planRateUpdate,
  ratesLockedFor,
  applyPlan,
  payrollEmployeeFor,
  ratesLocked,
  syncRates,
  describeSummary,
};
