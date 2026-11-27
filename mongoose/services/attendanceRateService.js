// The hourly rate saved on each employee attendance day (attendance.savedRate),
// so a past day keeps the rate it was really paid at and later rate changes
// don't alter it. Costing (payrollCalculationService.grossPayFromRecords,
// jobLabourService, payrollProviderService) uses the saved rate when a day has
// one, else the employee's current hourlyRate.
//
// Three ways a day gets its rate:
//  1. On approval (stampApproved): the employee's current hourlyRate, source
//     'staffology' when it came from Staffology (payroll.rateSource), else
//     'hcs-app'. Never replaces a 'staffology-payrun' rate.
//  2. From the pay run (correctFromPayRuns): each closed Staffology pay run
//     entry with a base hourly rate sets that rate on the person's employee
//     days dated StartDate..EndDate (Europe/London calendar days), source
//     'staffology-payrun'. Where two entries for the same person cover a day
//     with different rates, the day is left alone and counted as a conflict.
//  3. Backfill (backfill): the pay run pass, then every other approved
//     employee day with no saved rate gets the current rate, estimated: true.
//
// Subcontractor days never get a rate: they're paid on CIS invoices.
// The STAFFOLOGY database is only read. Stamping never fails an approval.
import mongoose from 'mongoose';
import { formatInTimeZone } from 'date-fns-tz';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { isStaffologyMode } from '../../services/staffologyModeService.js';
import { employeesByPayrollCode } from './payrollProviderService.js';

export const SOURCES = { PAYRUN: 'staffology-payrun', STAFFOLOGY: 'staffology', APP: 'hcs-app' };
const TZ = 'Europe/London';
const DAY_MS = 86400000;

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(typeof v === 'object' && v.toString ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => {
  const n = toNum(v);
  return n != null && n > 0 ? n : null;
};
const round4 = (n) => Number(n.toFixed(4));
const d128 = (n) => mongoose.Types.Decimal128.fromString(round4(n).toFixed(4));
const idStr = (v) => (v == null ? null : String(v._id ?? v));

/** London calendar day (yyyy-MM-dd) of a date. */
export const dayKey = (d) => (d ? formatInTimeZone(new Date(d), TZ, 'yyyy-MM-dd') : null);

/**
 * The rate to save on a day from the employee's current rate, or null when
 * the employee has no hourly rate (pure).
 */
export function stampFor(employee, { now = new Date(), estimated = false } = {}) {
  const hourly = positive(employee?.hourlyRate);
  if (hourly == null) return null;
  return {
    hourly: d128(hourly),
    source: employee?.payroll?.rateSource === 'staffology' ? SOURCES.STAFFOLOGY : SOURCES.APP,
    at: now,
    estimated: Boolean(estimated),
  };
}

/** Should approval stamp this record? An approved employee day without a pay run rate (pure). */
export function shouldStampOnApproval(record) {
  if (!record || !record.employeeId || record.subcontractorId) return false;
  if (record.status !== 'approved') return false;
  return record.savedRate?.source !== SOURCES.PAYRUN;
}

/**
 * Save the employee's current rate on records that have just been approved.
 * Best effort: logs and returns 0 on failure, so an approval never fails here.
 *
 * @param {object[]} records - attendance docs or lean records
 * @returns {Promise<number>} how many days were stamped
 */
export async function stampApproved(records = [], db = mdb) {
  try {
    const todo = records.map((r) => (r && typeof r.toObject === 'function' ? r.toObject() : r)).filter(shouldStampOnApproval);
    if (!todo.length) return 0;
    const Employee = db.INTERNAL?.employee;
    const Attendance = db.INTERNAL?.attendance;
    if (!Employee || !Attendance) return 0;
    const empIds = [...new Set(todo.map((r) => idStr(r.employeeId)))];
    const employees = await Employee.find({ _id: { $in: empIds } }).select('hourlyRate payroll.rateSource').lean();
    const byId = new Map(employees.map((e) => [String(e._id), e]));
    const now = new Date();
    const ops = [];
    for (const r of todo) {
      const stamp = stampFor(byId.get(idStr(r.employeeId)), { now });
      if (!stamp) continue;
      ops.push({ updateOne: {
        filter: { _id: r._id, status: 'approved', employeeId: { $ne: null }, 'savedRate.source': { $ne: SOURCES.PAYRUN } },
        update: { $set: { savedRate: stamp } },
      } });
    }
    if (!ops.length) return 0;
    const res = await Attendance.bulkWrite(ops, { ordered: false });
    return res.modifiedCount || 0;
  } catch (err) {
    logger.warn(`[attendanceRate] stamping on approval failed: ${err.message}`);
    return 0;
  }
}

// ── From the pay run ─────────────────────────────────────────────────────────

/**
 * Closed pay run entries that carry a base hourly rate, as day windows
 * (pure). Entries without the field (synced before it existed), open ones and
 * ones without dates are left out.
 */
export function payRunWindows(entries = []) {
  const out = [];
  for (const e of entries) {
    if (!e || e.IsClosed !== true) continue;
    const rate = positive(e.BaseHourlyRate);
    const from = dayKey(e.StartDate);
    const to = dayKey(e.EndDate);
    if (rate == null || !from || !to || from > to) continue;
    out.push({ from, to, rate: round4(rate) });
  }
  return out;
}

/**
 * For one person: the pay run rate each of their days should carry (pure).
 *
 * @param {object[]} windows - payRunWindows() for this person
 * @param {object[]} days - their attendance days (_id, date, savedRate)
 * @returns {{ updates: {_id, rate:number}[], matched: number, conflicts: object[], unchanged: number }}
 */
export function planPayRunRates(windows = [], days = []) {
  const updates = [];
  const conflicts = [];
  let matched = 0;
  let unchanged = 0;
  for (const d of days) {
    const k = dayKey(d.date);
    if (!k) continue;
    const rates = [...new Set(windows.filter((w) => k >= w.from && k <= w.to).map((w) => w.rate))];
    if (!rates.length) continue;
    if (rates.length > 1) { conflicts.push(d); continue; }
    matched += 1;
    const s = d.savedRate || {};
    const current = positive(s.hourly);
    if (s.source === SOURCES.PAYRUN && current != null && round4(current) === rates[0] && s.estimated !== true) {
      unchanged += 1;
      continue;
    }
    updates.push({ _id: d._id, rate: rates[0] });
  }
  return { updates, matched, conflicts, unchanged };
}

const models = (db) => ({
  Employee: db.INTERNAL?.employee || null,
  Attendance: db.INTERNAL?.attendance || null,
  Entry: db.STAFFOLOGY?.payrollpayrunentry || null,
});

/**
 * Set the paid rate on employee days covered by closed Staffology pay runs.
 * Idempotent. Only in Staffology mode.
 *
 * @returns {Promise<{entries:number, people:number, matched:number, fromPayRun:number, conflicts:number, conflictIds:Array, reason?:string}>}
 */
export async function correctFromPayRuns({ db = mdb, now = new Date() } = {}) {
  const summary = { entries: 0, people: 0, matched: 0, fromPayRun: 0, conflicts: 0, conflictIds: [] };
  if (!isStaffologyMode()) return { ...summary, reason: 'Not in Staffology mode' };
  const { Employee, Attendance, Entry } = models(db);
  if (!Employee || !Attendance || !Entry) return { ...summary, reason: 'Staffology data is not available' };

  const [entries, employees] = await Promise.all([
    Entry.find({ IsClosed: true, BaseHourlyRate: { $gt: 0 } }).select('PayrollCode StartDate EndDate IsClosed BaseHourlyRate').lean(),
    Employee.find({ 'payroll.payrollId': { $nin: [null, ''] } }).select('_id payroll.payrollId').lean(),
  ]);
  summary.entries = entries.length;
  const byCode = employeesByPayrollCode(employees);
  const entriesByEmployee = new Map();
  for (const e of entries) {
    const emp = byCode.get(String(e.PayrollCode ?? '').trim().toLowerCase());
    if (!emp) continue;
    const k = String(emp._id);
    if (!entriesByEmployee.has(k)) entriesByEmployee.set(k, []);
    entriesByEmployee.get(k).push(e);
  }

  for (const [employeeId, list] of entriesByEmployee) {
    const windows = payRunWindows(list);
    if (!windows.length) continue;
    summary.people += 1;
    // Stored dates are London midnights: a day's slack either side, then the
    // window is applied by London day key.
    const lo = new Date(Math.min(...list.map((e) => new Date(e.StartDate).getTime())) - DAY_MS);
    const hi = new Date(Math.max(...list.map((e) => new Date(e.EndDate).getTime())) + 2 * DAY_MS);
    const days = await Attendance.find({ employeeId, date: { $gte: lo, $lt: hi } }).select('_id date savedRate').lean();
    const plan = planPayRunRates(windows, days);
    summary.matched += plan.matched;
    summary.conflicts += plan.conflicts.length;
    summary.conflictIds.push(...plan.conflicts.map((d) => d._id));
    if (!plan.updates.length) continue;
    const res = await Attendance.bulkWrite(plan.updates.map((u) => ({ updateOne: {
      filter: { _id: u._id, employeeId: { $ne: null } },
      update: { $set: { savedRate: { hourly: d128(u.rate), source: SOURCES.PAYRUN, at: now, estimated: false } } },
    } })), { ordered: false });
    summary.fromPayRun += res.modifiedCount || 0;
  }
  logger.info(`[attendanceRate] pay run rates: ${summary.entries} entries, ${summary.people} people, ${summary.matched} days covered, ${summary.fromPayRun} updated, ${summary.conflicts} conflicts`);
  return summary;
}

/** Plain words for a pay run pass, for a flash message (pure). */
export function describePayRun(s) {
  if (!s || s.reason) return '';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let text = `Pay runs: ${plural(s.fromPayRun, 'attendance day')} given the rate Staffology paid`;
  if (s.conflicts) text += `, ${plural(s.conflicts, 'day')} left alone because two pay runs disagree`;
  return `${text}.`;
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/**
 * Give past employee days a saved rate: the pay run pass, then every other
 * approved day without one gets the employee's current rate, estimated.
 * Days with a pay run conflict are left alone.
 *
 * @returns {Promise<{stamped:number, fromPayRun:number, estimated:number, conflicts:number, skipped:number}>}
 */
export async function backfill({ db = mdb, now = new Date() } = {}) {
  const payRun = await correctFromPayRuns({ db, now });
  const out = { stamped: 0, fromPayRun: payRun.fromPayRun, estimated: 0, conflicts: payRun.conflicts, skipped: 0 };
  const { Employee, Attendance } = models(db);
  if (!Employee || !Attendance) return { ...out, stamped: out.fromPayRun };

  const conflictIds = new Set(payRun.conflictIds.map(String));
  const days = await Attendance.find({
    employeeId: { $ne: null },
    status: 'approved',
    'savedRate.hourly': null,
  }).select('_id employeeId').lean();
  const todo = days.filter((d) => !conflictIds.has(String(d._id)));
  out.skipped += days.length - todo.length;

  const empIds = [...new Set(todo.map((d) => idStr(d.employeeId)))];
  const employees = empIds.length
    ? await Employee.find({ _id: { $in: empIds } }).select('hourlyRate payroll.rateSource').lean()
    : [];
  const byId = new Map(employees.map((e) => [String(e._id), e]));
  const ops = [];
  for (const d of todo) {
    const stamp = stampFor(byId.get(idStr(d.employeeId)), { now, estimated: true });
    if (!stamp) { out.skipped += 1; continue; }
    ops.push({ updateOne: { filter: { _id: d._id, 'savedRate.hourly': null }, update: { $set: { savedRate: stamp } } } });
  }
  for (let i = 0; i < ops.length; i += 500) {
    const res = await Attendance.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    out.estimated += res.modifiedCount || 0;
  }
  out.stamped = out.fromPayRun + out.estimated;
  logger.info(`[attendanceRate] backfill: stamped ${out.stamped} (${out.fromPayRun} from pay runs, ${out.estimated} estimated), ${out.conflicts} conflicts, ${out.skipped} skipped`);
  return out;
}

export default {
  SOURCES,
  dayKey,
  stampFor,
  shouldStampOnApproval,
  stampApproved,
  payRunWindows,
  planPayRunRates,
  correctFromPayRuns,
  describePayRun,
  backfill,
};
