// Payroll provider (Staffology) data next to hcs-app's own attendance.
//
// Payroll is run in Staffology. hcs-sync copies its employees and pay run
// results into the STAFFOLOGY namespace (its own database); this service reads
// them and lines each pay entry up against the approved attendance for the
// same dates, so a week paid differently from what was approved stands out.
//
// Matching: a Staffology employee is an hcs-app employee when its PayrollCode
// equals employee.payroll.payrollId. No NI numbers are involved.
//
// Windows: each pay entry is compared over its OWN StartDate–EndDate, so the
// provider's period numbering never has to line up with hcs-app's payroll weeks.
//
// The compare functions are pure (everything passed in) so they can be tested
// without a database; the load* functions do the reads.
import { formatInTimeZone } from 'date-fns-tz';
import mdb from './mongooseDatabaseService.js';
import { grossPayFromRecords, toNum } from './payrollCalculationService.js';

const TZ = 'Europe/London';
const WORK_TYPES = ['work', 'training'];
const UNAPPROVED = ['planned', 'pending', 'site-approved'];
/** Paid and expected gross may differ by rounding; anything above this is flagged. */
export const GROSS_TOLERANCE = 1;

export const FLAGS = {
  'unmatched': 'Not linked to an hcs-app employee',
  'paid-no-attendance': 'Paid, but no approved attendance',
  'attendance-not-paid': 'Approved attendance, but not paid',
  'gross-differs': 'Paid gross differs from approved attendance',
  'unapproved-days': 'Days still waiting for approval',
  'changed-after-close': 'Attendance changed after the pay run closed',
};

const id = (x) => (x == null ? null : String(x._id || x));
const dayKey = (d) => (d ? formatInTimeZone(new Date(d), TZ, 'yyyy-MM-dd') : null);
const round2 = (n) => Math.round(n * 100) / 100;
const normCode = (c) => (c == null ? '' : String(c).trim().toLowerCase());
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/** "First Last" for a payroll employee or entry. */
export function payrollName(pe) {
  if (!pe) return '';
  return [pe.FirstName, pe.LastName].filter(Boolean).join(' ') || pe.EmployeeName || '';
}

/** PayrollCode (normalised) → hcs-app employee, for employees that have a payroll ID. */
export function employeesByPayrollCode(employees = []) {
  const out = new Map();
  for (const e of employees) {
    const code = normCode(e?.payroll?.payrollId);
    if (code && !out.has(code)) out.set(code, e);
  }
  return out;
}

/**
 * Staffology employees with the hcs-app employee each one matches, and for the
 * unmatched ones a name-based suggestion (an employee without a payroll ID
 * whose name matches exactly, ignoring case, spaces and punctuation).
 */
export function matchEmployees(payrollEmployees = [], employees = []) {
  const byCode = employeesByPayrollCode(employees);
  const unlinked = employees.filter((e) => !normCode(e?.payroll?.payrollId));
  return payrollEmployees.map((pe) => {
    const employee = byCode.get(normCode(pe.PayrollCode)) || null;
    let suggestion = null;
    if (!employee) {
      const want = normName(payrollName(pe));
      suggestion = want ? unlinked.find((e) => normName(e.name) === want) || null : null;
    }
    return { payrollEmployee: pe, employee, suggestion };
  });
}

/** Records of one employee that fall on [from, to] (yyyy-MM-dd, inclusive). */
function recordsInWindow(records, from, to) {
  return records.filter((r) => {
    const k = dayKey(r.date);
    return k && k >= from && k <= to;
  });
}

/** Sum of approved work/training: hours and expected gross, plus the day keys. */
export function summariseAttendance(records, employee) {
  const work = records.filter((r) => WORK_TYPES.includes(r.type || 'work'));
  const approved = work.filter((r) => r.status === 'approved');
  const unapproved = work.filter((r) => UNAPPROVED.includes(r.status));
  return {
    approvedDays: approved.length,
    approvedHours: round2(approved.reduce((s, r) => s + toNum(r.hoursWorked), 0)),
    expectedGross: grossPayFromRecords(approved, employee),
    unapprovedDays: unapproved.map((r) => dayKey(r.date)).sort(),
    work,
  };
}

/**
 * The moment after which an attendance change means "changed after it was
 * paid": the end of the payment day, or the sync time when there is no date.
 */
function closedAt(entry) {
  if (entry.PaymentDate) {
    const k = dayKey(entry.PaymentDate);
    return new Date(`${k}T23:59:59.999Z`);
  }
  return entry.SyncedAt ? new Date(entry.SyncedAt) : null;
}

/**
 * Compare one pay period's entries with attendance.
 *
 * @param {object} p
 * @param {object[]} p.entries          payroll pay run entries (lean) for one period
 * @param {object[]} p.employees        hcs-app employees (lean), with payroll.payrollId
 * @param {object[]} p.attendance       attendance (lean) covering the period, any status
 * @param {object[]} [p.payrollEmployees] Staffology employees, to tell who is paid on another schedule
 * @returns {{ rows: object[], window: {from, to}|null, flagged: number }}
 */
export function comparePeriod({ entries = [], employees = [], attendance = [], payrollEmployees = [] }) {
  const byCode = employeesByPayrollCode(employees);
  const byEmployeeId = new Map();
  for (const r of attendance) {
    const k = id(r.employeeId);
    if (!k) continue;
    if (!byEmployeeId.has(k)) byEmployeeId.set(k, []);
    byEmployeeId.get(k).push(r);
  }

  const rows = [];
  const paidEmployeeIds = new Set();
  let from = null;
  let to = null;

  for (const entry of entries) {
    const start = dayKey(entry.StartDate);
    const end = dayKey(entry.EndDate);
    if (start && (!from || start < from)) from = start;
    if (end && (!to || end > to)) to = end;

    const employee = byCode.get(normCode(entry.PayrollCode)) || null;
    const t = entry.Totals || {};
    const paidGross = round2(toNum(t.Gross));
    const row = {
      entry,
      employee,
      name: employee?.name || entry.EmployeeName || '',
      payrollCode: entry.PayrollCode || '',
      window: { from: start, to: end },
      paid: {
        gross: paidGross,
        tax: round2(toNum(t.Tax)),
        employeeNi: round2(toNum(t.EmployeeNi)),
        employerNi: round2(toNum(t.EmployerNi)),
        netPay: round2(toNum(t.NetPay)),
        totalCost: round2(toNum(t.TotalCost)),
      },
      approvedDays: 0,
      approvedHours: 0,
      expectedGross: 0,
      difference: null,
      unapprovedDays: [],
      flags: [],
    };

    if (!employee) {
      row.flags.push('unmatched');
      rows.push(row);
      continue;
    }
    paidEmployeeIds.add(id(employee));

    const records = start && end ? recordsInWindow(byEmployeeId.get(id(employee)) || [], start, end) : [];
    const s = summariseAttendance(records, employee);
    row.approvedDays = s.approvedDays;
    row.approvedHours = s.approvedHours;
    row.expectedGross = s.expectedGross;
    row.unapprovedDays = s.unapprovedDays;
    row.difference = round2(paidGross - s.expectedGross);

    if (paidGross > 0 && s.approvedDays === 0) row.flags.push('paid-no-attendance');
    else if (s.approvedDays > 0 && paidGross <= 0) row.flags.push('attendance-not-paid');
    else if (s.approvedDays > 0 && Math.abs(row.difference) > GROSS_TOLERANCE) row.flags.push('gross-differs');
    if (s.unapprovedDays.length) row.flags.push('unapproved-days');

    const cutoff = entry.IsClosed ? closedAt(entry) : null;
    if (cutoff && s.work.some((r) => r.updatedAt && new Date(r.updatedAt) > cutoff)) {
      row.flags.push('changed-after-close');
    }
    rows.push(row);
  }

  // People with approved attendance in the period but no pay entry. Skip anyone
  // Staffology pays on a different schedule (they're in another period's run).
  if (from && to) {
    const period = entries[0]?.PayPeriod;
    const otherSchedule = new Set(
      payrollEmployees
        .filter((pe) => pe.PayPeriod && period && pe.PayPeriod !== period)
        .map((pe) => normCode(pe.PayrollCode)),
    );
    for (const employee of employees) {
      const eid = id(employee);
      if (paidEmployeeIds.has(eid)) continue;
      if (otherSchedule.has(normCode(employee?.payroll?.payrollId))) continue;
      const records = recordsInWindow(byEmployeeId.get(eid) || [], from, to);
      const s = summariseAttendance(records, employee);
      if (!s.approvedDays) continue;
      rows.push({
        entry: null,
        employee,
        name: employee.name || '',
        payrollCode: employee?.payroll?.payrollId || '',
        window: { from, to },
        paid: null,
        approvedDays: s.approvedDays,
        approvedHours: s.approvedHours,
        expectedGross: s.expectedGross,
        difference: round2(-s.expectedGross),
        unapprovedDays: s.unapprovedDays,
        flags: ['attendance-not-paid', ...(s.unapprovedDays.length ? ['unapproved-days'] : [])],
      });
    }
  }

  rows.sort((a, b) => (b.flags.length - a.flags.length) || a.name.localeCompare(b.name));
  return { rows, window: from && to ? { from, to } : null, flagged: rows.filter((r) => r.flags.length).length };
}

/** Period key used by the picker: TaxYear-PayPeriod-Period-Ordinal. */
export function periodKey(p) {
  return `${p.TaxYear}-${p.PayPeriod}-${p.Period}-${p.Ordinal || 1}`;
}

export function parsePeriodKey(s) {
  const m = /^(\d{4})-([A-Za-z]+)-(\d{1,3})-(\d{1,2})$/.exec(String(s || ''));
  return m ? { TaxYear: Number(m[1]), PayPeriod: m[2], Period: Number(m[3]), Ordinal: Number(m[4]) } : null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

const models = () => ({
  Entry: mdb.STAFFOLOGY?.payrollpayrunentry || null,
  PayrollEmployee: mdb.STAFFOLOGY?.payrollemployee || null,
});

/** True when the namespace is loaded and has at least one pay entry. */
export async function hasData() {
  const { Entry } = models();
  if (!Entry) return false;
  return Boolean(await Entry.exists({}));
}

/** Every synced period, newest first, with its dates and entry count. */
export async function listPeriods() {
  const { Entry } = models();
  if (!Entry) return [];
  const rows = await Entry.aggregate([
    { $group: {
      _id: { TaxYear: '$TaxYear', PayPeriod: '$PayPeriod', Period: '$Period', Ordinal: { $ifNull: ['$Ordinal', 1] } },
      StartDate: { $min: '$StartDate' },
      EndDate: { $max: '$EndDate' },
      PaymentDate: { $max: '$PaymentDate' },
      count: { $sum: 1 },
    } },
    { $sort: { StartDate: -1, '_id.Ordinal': 1 } },
  ]);
  return rows.map((r) => ({ ...r._id, StartDate: r.StartDate, EndDate: r.EndDate, PaymentDate: r.PaymentDate, count: r.count }));
}

/** One period compared with attendance. */
export async function loadComparison(period) {
  const { Entry, PayrollEmployee } = models();
  const Employee = mdb.INTERNAL?.employee;
  const Attendance = mdb.INTERNAL?.attendance;
  if (!Entry || !Employee || !Attendance) return { rows: [], window: null, flagged: 0 };

  const filter = { TaxYear: period.TaxYear, PayPeriod: period.PayPeriod, Period: period.Period };
  filter.Ordinal = period.Ordinal > 1 ? period.Ordinal : { $in: [1, null] };
  const entries = await Entry.find(filter).lean();
  if (!entries.length) return { rows: [], window: null, flagged: 0 };

  const starts = entries.map((e) => e.StartDate).filter(Boolean).map((d) => new Date(d));
  const ends = entries.map((e) => e.EndDate).filter(Boolean).map((d) => new Date(d));
  // A day either side, so London midnights stored in UTC are never cut off;
  // the per-entry window is applied by day key in comparePeriod.
  const lo = new Date(Math.min(...starts) - 86400000);
  const hi = new Date(Math.max(...ends) + 2 * 86400000);

  const [employees, attendance, payrollEmployees] = await Promise.all([
    Employee.find({}).select('name uuid status hourlyRate payroll.payrollId').lean(),
    Attendance.find({ employeeId: { $ne: null }, date: { $gte: lo, $lt: hi } })
      .select('employeeId date type status hoursWorked dayRate updatedAt').lean(),
    PayrollEmployee ? PayrollEmployee.find({}).select('PayrollCode PayPeriod').lean() : [],
  ]);
  return comparePeriod({ entries, employees, attendance, payrollEmployees });
}

/** Staffology employees with their hcs-app match. */
export async function loadEmployeeMatches() {
  const { PayrollEmployee } = models();
  const Employee = mdb.INTERNAL?.employee;
  if (!PayrollEmployee || !Employee) return [];
  const [payrollEmployees, employees] = await Promise.all([
    PayrollEmployee.find({}).sort({ Status: 1, LastName: 1, FirstName: 1 }).lean(),
    Employee.find({}).select('name uuid status payroll.payrollId').lean(),
  ]);
  return matchEmployees(payrollEmployees, employees);
}

/** The latest pay entries for one hcs-app employee, newest first. */
export async function recentPayForEmployee(employee, limit = 6) {
  const { Entry } = models();
  const code = employee?.payroll?.payrollId;
  if (!Entry || !code) return [];
  return Entry.find({ PayrollCode: String(code).trim() }).sort({ PaymentDate: -1, StartDate: -1 }).limit(limit).lean();
}

export default {
  FLAGS,
  GROSS_TOLERANCE,
  payrollName,
  employeesByPayrollCode,
  matchEmployees,
  summariseAttendance,
  comparePeriod,
  periodKey,
  parsePeriodKey,
  hasData,
  listPeriods,
  loadComparison,
  loadEmployeeMatches,
  recentPayForEmployee,
};
