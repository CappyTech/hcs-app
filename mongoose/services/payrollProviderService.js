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
import configService from '../../services/configService.js';
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
 * Does an hcs-app name look like this Staffology person? hcs-app names are
 * often a first name or a short form ("Dan" for Daniel), so beyond an exact
 * full-name match, the first word of the hcs-app name may equal the Staffology
 * first name or be a prefix of it, or the other way round (3+ letters).
 */
export function nameLooksLike(appName, pe) {
  const full = normName(payrollName(pe));
  const app = normName(appName);
  if (!app) return false;
  if (full && app === full) return true;
  const first = normName(pe?.FirstName || String(pe?.EmployeeName || '').split(/\s+/)[0]);
  const appFirst = normName(String(appName || '').trim().split(/\s+/)[0]);
  if (!first || !appFirst) return false;
  if (first === appFirst) return true;
  const [short, long] = first.length <= appFirst.length ? [first, appFirst] : [appFirst, first];
  return short.length >= 3 && long.startsWith(short);
}

const activeFirst = (a, b) =>
  (a.status === 'inactive') - (b.status === 'inactive') || String(a.name || '').localeCompare(String(b.name || ''));

/**
 * Staffology employees with the hcs-app employee each one matches. Unmatched
 * ones also get:
 *  - suggestion: the one unlinked employee whose name looks like theirs, but
 *    only when exactly one does, and that employee isn't also the likely match
 *    for another Staffology person (an exact full-name match always wins);
 *  - candidates: every employee without a payroll ID, suggestion first, then
 *    active before inactive, for a pick-list.
 */
export function matchEmployees(payrollEmployees = [], employees = []) {
  const byCode = employeesByPayrollCode(employees);
  const unlinked = employees.filter((e) => !normCode(e?.payroll?.payrollId)).sort(activeFirst);

  const pending = payrollEmployees.filter((pe) => !byCode.get(normCode(pe.PayrollCode)));
  const guess = new Map(); // pe → employee
  for (const pe of pending) {
    const full = normName(payrollName(pe));
    const exact = full ? unlinked.filter((e) => normName(e.name) === full) : [];
    const loose = exact.length ? exact : unlinked.filter((e) => nameLooksLike(e.name, pe));
    if (loose.length === 1) guess.set(pe, loose[0]);
  }
  // An employee guessed for two Staffology people is no guess at all.
  const claims = new Map();
  for (const e of guess.values()) claims.set(e, (claims.get(e) || 0) + 1);

  return payrollEmployees.map((pe) => {
    const employee = byCode.get(normCode(pe.PayrollCode)) || null;
    if (employee) return { payrollEmployee: pe, employee, suggestion: null, candidates: [] };
    const g = guess.get(pe);
    const suggestion = g && claims.get(g) === 1 ? g : null;
    const candidates = suggestion ? [suggestion, ...unlinked.filter((e) => e !== suggestion)] : unlinked;
    return { payrollEmployee: pe, employee: null, suggestion, candidates };
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

// ── Staffology mode pages (dashboard, runs, employee, My pay) ────────────────

const TOTAL_KEYS = ['Gross', 'Tax', 'EmployeeNi', 'EmployerNi', 'EmployeePension', 'EmployerPension', 'NetPay', 'TakeHomePay', 'TotalCost'];
const sumTotals = () => Object.fromEntries(TOTAL_KEYS.map((k) => [k, { $sum: { $ifNull: [`$Totals.${k}`, 0] } }]));
const pickTotals = (r) => Object.fromEntries(TOTAL_KEYS.map((k) => [k, round2(toNum(r[k]))]));

/** Add up the totals of a list of entries (pure). */
export function addTotals(entries = []) {
  const out = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
  for (const e of entries) for (const k of TOTAL_KEYS) out[k] += toNum(e?.Totals?.[k]);
  return Object.fromEntries(TOTAL_KEYS.map((k) => [k, round2(out[k])]));
}

/** Every synced pay run (one per period + ordinal), newest first, with totals. */
export async function listRuns({ taxYear } = {}) {
  const { Entry } = models();
  if (!Entry) return [];
  const match = taxYear ? [{ $match: { TaxYear: Number(taxYear) } }] : [];
  const rows = await Entry.aggregate([
    ...match,
    { $group: {
      _id: { TaxYear: '$TaxYear', PayPeriod: '$PayPeriod', Period: '$Period', Ordinal: { $ifNull: ['$Ordinal', 1] } },
      StartDate: { $min: '$StartDate' },
      EndDate: { $max: '$EndDate' },
      PaymentDate: { $max: '$PaymentDate' },
      people: { $sum: 1 },
      open: { $sum: { $cond: [{ $eq: ['$IsClosed', true] }, 0, 1] } },
      ...sumTotals(),
    } },
    { $sort: { StartDate: -1, '_id.Ordinal': 1 } },
  ]);
  return rows.map((r) => ({
    ...r._id, StartDate: r.StartDate, EndDate: r.EndDate, PaymentDate: r.PaymentDate,
    people: r.people, closed: r.open === 0, totals: pickTotals(r),
  }));
}

/** Tax years present in the synced data, newest first. */
export async function listTaxYears() {
  const { Entry } = models();
  if (!Entry) return [];
  return (await Entry.distinct('TaxYear')).filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
}

/**
 * How often the company pays people (Settings → Connections → Staffology,
 * PAYROLL_PAY_FREQUENCY). Values are Staffology's PayPeriod names. Drives the
 * payroll dashboard breakdown and which pay runs the pages pick by default.
 */
export const PAY_FREQUENCIES = {
  Weekly: { weeks: 1, unit: 'Week', heading: 'By tax week' },
  Fortnightly: { weeks: 2, unit: 'Fortnight', heading: 'By tax fortnight' },
  FourWeekly: { weeks: 4, unit: 'Period', heading: 'By four-week period' },
  Monthly: { unit: 'Month', heading: 'By tax month' },
};
export const DEFAULT_PAY_FREQUENCY = 'Weekly';

export function payFrequency() {
  const v = String(configService.get('PAYROLL_PAY_FREQUENCY', '') || '').trim();
  return PAY_FREQUENCIES[v] ? v : DEFAULT_PAY_FREQUENCY;
}

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const utcDay = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };

/**
 * Pay grouped by tax week, fortnight, four-week period or month (from the
 * payment date, falling back to the end date), for one tax year (pure). Week
 * 1 starts on 6 April; week 53 is the last day or two of the tax year.
 */
export function groupByPayPeriod(entries = [], taxYear, frequency = DEFAULT_PAY_FREQUENCY) {
  const freq = PAY_FREQUENCIES[frequency] ? frequency : DEFAULT_PAY_FREQUENCY;
  const { weeks } = PAY_FREQUENCIES[freq];
  const yearStart = Date.UTC(taxYear, 3, 6);
  const groups = new Map();
  for (const e of entries) {
    const d = e.PaymentDate || e.EndDate;
    if (!d) continue;
    const key = dayKey(d);
    let period;
    if (weeks) {
      const days = Math.floor((utcDay(key) - yearStart) / 86400000);
      if (days < 0 || days > 365) continue;
      period = Math.floor(days / (7 * weeks)) + 1;
    } else {
      const [y, m, day] = key.split('-').map(Number);
      // Tax month n runs from the 6th of month (n + 3) to the 5th of the next.
      period = (y - taxYear) * 12 + (m - 4) - (day < 6 ? 1 : 0) + 1;
      if (period < 1 || period > 12) continue;
    }
    if (!groups.has(period)) groups.set(period, []);
    groups.get(period).push(e);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([period, list]) => ({
      period,
      label: weeks ? `${PAY_FREQUENCIES[freq].unit} ${period}` : `M${period} · ${MONTHS[period - 1]}`,
      start: weeks ? new Date(yearStart + (period - 1) * weeks * 7 * 86400000) : new Date(Date.UTC(taxYear, 3 + period - 1, 6)),
      people: new Set(list.map((e) => e.PayrollCode)).size,
      runs: new Set(list.map(periodKey)).size,
      totals: addTotals(list),
    }));
}

/** Pay grouped by tax month (1 = April); kept for callers that want months. */
export function groupByTaxMonth(entries = [], taxYear) {
  return groupByPayPeriod(entries, taxYear, 'Monthly').map(({ period, ...rest }) => ({ taxMonth: period, ...rest }));
}

/** The dashboard breakdown for one tax year, by the company's pay frequency. */
export async function paySummary(taxYear, frequency = payFrequency()) {
  const { Entry } = models();
  const meta = PAY_FREQUENCIES[frequency] || PAY_FREQUENCIES[DEFAULT_PAY_FREQUENCY];
  if (!Entry) return { taxYear, frequency, ...meta, periods: [], totals: addTotals([]) };
  const entries = await Entry.find({ TaxYear: Number(taxYear) }).select('PayrollCode TaxYear PayPeriod Period Ordinal PaymentDate EndDate Totals').lean();
  return { taxYear: Number(taxYear), frequency, ...meta, periods: groupByPayPeriod(entries, Number(taxYear), frequency), totals: addTotals(entries) };
}

/** Dashboard figures for one tax year. */
export async function dashboardSummary(taxYear) {
  const { Entry, PayrollEmployee } = models();
  const Employee = mdb.INTERNAL?.employee;
  if (!Entry) return { taxYear, runs: [], totals: addTotals([]), latest: null, unlinked: 0 };
  const [runs, entries] = await Promise.all([
    listRuns({ taxYear }),
    Entry.find({ TaxYear: Number(taxYear) }).select('Totals').lean(),
  ]);
  let unlinked = 0;
  if (PayrollEmployee && Employee) {
    const [pes, emps] = await Promise.all([
      PayrollEmployee.find({ Status: { $ne: 'Former' } }).select('PayrollCode Status').lean(),
      Employee.find({}).select('payroll.payrollId').lean(),
    ]);
    const codes = employeesByPayrollCode(emps);
    unlinked = pes.filter((pe) => !codes.has(normCode(pe.PayrollCode))).length;
  }
  // The latest run on the company's pay frequency (fall back to the latest of any kind).
  const freq = payFrequency();
  const main = runs.find((r) => r.PayPeriod === freq) || runs[0];
  const latest = main ? { ...main, comparison: await loadComparison(main) } : null;
  return { taxYear: Number(taxYear), runs: runs.slice(0, 10), totals: addTotals(entries), latest, unlinked };
}

/** Every pay entry for a payroll code, newest first. */
export async function entriesForPayrollCode(code) {
  const { Entry } = models();
  if (!Entry || !code) return [];
  return Entry.find({ PayrollCode: String(code).trim() }).sort({ PaymentDate: -1, StartDate: -1 }).lean();
}

/** The Staffology employee record for a payroll code. */
export async function payrollEmployeeByCode(code) {
  const { PayrollEmployee } = models();
  if (!PayrollEmployee || !code) return null;
  return PayrollEmployee.findOne({ PayrollCode: String(code).trim() }).lean();
}

/** One pay entry by its hcs uuid. */
export async function entryByUuid(uuid) {
  const { Entry } = models();
  if (!Entry || !uuid) return null;
  return Entry.findOne({ uuid: String(uuid) }).lean();
}

/** Entries grouped by tax year with year-to-date totals (pure), newest year first. */
export function groupByTaxYear(entries = []) {
  const years = new Map();
  for (const e of entries) {
    const y = e.TaxYear;
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(e);
  }
  return [...years.entries()].sort((a, b) => b[0] - a[0]).map(([taxYear, list]) => ({ taxYear, entries: list, totals: addTotals(list) }));
}

/**
 * A closed Staffology pay entry covering a date, shaped like the payroll run (status 'paid')
 * attendanceService.getLockedRunForDate returns, so attendance in a paid week
 * is locked the same way. null when none.
 */
export async function closedRunForDate(date) {
  const { Entry } = models();
  if (!Entry || !date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  // Stored dates are London midnights; a day's slack either side.
  const e = await Entry.findOne({
    IsClosed: true,
    StartDate: { $lte: new Date(d.getTime() + 86400000) },
    EndDate: { $gte: new Date(d.getTime() - 86400000) },
  }).sort({ PaymentDate: -1 }).lean();
  if (!e) return null;
  const k = dayKey(d);
  if (k < dayKey(e.StartDate) || k > dayKey(e.EndDate)) return null;
  return {
    source: 'staffology',
    taxYear: e.TaxYear,
    taxMonth: null,
    taxWeek: /week/i.test(e.PayPeriod || '') ? e.Period : null,
    frequency: String(e.PayPeriod || '').toLowerCase(),
    status: 'paid',
    periodStart: e.StartDate,
    periodEnd: e.EndDate,
  };
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
  addTotals,
  listRuns,
  listTaxYears,
  groupByTaxMonth,
  groupByPayPeriod,
  paySummary,
  payFrequency,
  PAY_FREQUENCIES,
  dashboardSummary,
  entriesForPayrollCode,
  payrollEmployeeByCode,
  entryByUuid,
  groupByTaxYear,
  closedRunForDate,
};
