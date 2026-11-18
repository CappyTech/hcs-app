import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import mongoose from 'mongoose';
import mdb from './mongooseDatabaseService.js';
import { scopeQuery } from '../../services/dataScopingService.js';
import { jobLabel } from './jobRegisterService.js';

/**
 * One person's attendance across weeks: an employee or a subcontractor, every
 * day in a date range, grouped by week with totals.
 *
 * Who sees what is the attendance read scope (dataScopingService), the same
 * rule /daily filters by: admin and all-records grants see everyone, a
 * Site Manager or Supervisor sees days on their sites, an employee or
 * subcontractor sees their own. The scope is part of the query, so a page
 * never fetches a day the viewer may not see.
 */

const TZ = 'Europe/London';
const DAY_MS = 24 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const KINDS = Object.freeze({
  employee: { field: 'employeeId', label: 'Employee', recordPath: '/employee/read/' },
  subcontractor: { field: 'subcontractorId', label: 'Subcontractor', recordPath: '/supplier/read/' },
});

export const TYPE_LABELS = Object.freeze({
  work: 'Work', training: 'Training', holiday: 'Holiday', sick: 'Sick', leave: 'Leave', off: 'Off',
});
export const STATUS_LABELS = Object.freeze({
  planned: 'Planned', pending: 'Pending', 'site-approved': 'Site approved', approved: 'Approved', rejected: 'Rejected',
});
// Waiting for someone: confirmed by the person, or approved by the site, but not yet final
const WAITING = new Set(['pending', 'site-approved']);

const ymd = (d) => formatInTimeZone(d, TZ, 'yyyy-MM-dd');
const noonUTC = (s) => new Date(`${s}T12:00:00Z`);
function addDays(s, n) {
  const d = noonUTC(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(s) {
  const dow = noonUTC(s).getUTCDay(); // 0 = Sunday
  return addDays(s, dow === 0 ? -6 : 1 - dow);
}
// UK tax year: 6 April to 5 April
function taxYearStart(s) {
  const year = Number(s.slice(0, 4));
  return s >= `${year}-04-06` ? `${year}-04-06` : `${year - 1}-04-06`;
}

/**
 * The date range from the query string. `preset` is 4w, 13w (default) or
 * tax; `from`/`to` (YYYY-MM-DD) win over it. The end runs to the end of this
 * week by default, so planned days for the rest of the week show.
 */
export function rangeFrom(query = {}, now = new Date()) {
  const today = ymd(now);
  const weekEnd = addDays(mondayOf(today), 6);
  const presets = {
    '4w': { from: addDays(mondayOf(today), -21), label: 'Last 4 weeks' },
    '13w': { from: addDays(mondayOf(today), -84), label: 'Last 13 weeks' },
    tax: { from: taxYearStart(today), label: 'This tax year' },
  };
  const preset = presets[query.preset] ? query.preset : '13w';
  let from = YMD.test(query.from || '') ? query.from : presets[preset].from;
  let to = YMD.test(query.to || '') ? query.to : weekEnd;
  if (from > to) [from, to] = [to, from];
  const custom = YMD.test(query.from || '') || YMD.test(query.to || '');
  return {
    from, to,
    preset: custom ? null : preset,
    label: custom ? null : presets[preset].label,
    presets: Object.entries(presets).map(([key, p]) => ({ key, label: p.label })),
    start: fromZonedTime(`${from}T00:00:00`, TZ),
    end: fromZonedTime(`${to}T23:59:59.999`, TZ),
  };
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

function siteOf(rec) {
  if (rec.jobRegisterId) {
    const label = jobLabel(rec.jobRegisterId);
    if (label.main) return label.main;
  }
  return rec.contractId?.title || rec.locationId?.name || '';
}

function emptyTotals() {
  return { days: 0, worked: 0, hours: 0, byType: {}, approved: 0, waiting: 0, planned: 0, rejected: 0 };
}
function addTo(t, day) {
  t.days += 1;
  if (day.type === 'work' || day.type === 'training') t.worked += 1;
  if (day.hours !== null && day.type !== 'off') t.hours += day.hours;
  t.byType[day.type] = (t.byType[day.type] || 0) + 1;
  if (day.status === 'approved') t.approved += 1;
  else if (WAITING.has(day.status)) t.waiting += 1;
  else if (day.status === 'planned') t.planned += 1;
  else if (day.status === 'rejected') t.rejected += 1;
}

/** Load the person by uuid: an INTERNAL employee, or a REST supplier for a subcontractor. */
async function findPerson(kind, uuid) {
  if (kind === 'employee') {
    const e = await mdb.INTERNAL.employee.findOne({ uuid }).select('_id uuid name position status').lean();
    return e ? { _id: e._id, uuid: e.uuid, name: e.name, detail: e.position || '' } : null;
  }
  const s = await mdb.REST.supplier.findOne({ uuid }).select('_id uuid Name Code').lean();
  return s ? { _id: s._id, uuid: s.uuid, name: s.Name, detail: s.Code || '' } : null;
}

/** The viewer's read scope on attendance merged with `where`; null when they can't read it. */
async function scoped(req, where) {
  const scope = await scopeQuery(req, 'attendance', 'r');
  if (scope === null) return null;
  return Object.keys(scope).length ? { $and: [where, scope] } : where;
}

/**
 * One person's days in the range, newest week first.
 * Returns { notFound } when there is no such person, { denied } when the
 * viewer may read no attendance, else { person, kind, weeks, totals }.
 */
export async function personHistory(req, kind, uuid, range) {
  const k = KINDS[kind];
  if (!k) return { notFound: true };
  const person = await findPerson(kind, uuid);
  if (!person) return { notFound: true };
  const filter = await scoped(req, { [k.field]: person._id, date: { $gte: range.start, $lte: range.end } });
  if (filter === null) return { denied: true };

  const records = await mdb.INTERNAL.attendance.find(filter)
    .select('uuid date type status hoursWorked notes rejectionReason contractId jobRegisterId locationId')
    .populate('contractId', 'title')
    .populate('locationId', 'name')
    .populate('jobRegisterId', '_id uuid projectNumber site client contact description')
    .sort({ date: 1 })
    .lean();

  const totals = emptyTotals();
  const byWeek = new Map();
  for (const rec of records) {
    const date = ymd(rec.date);
    const day = {
      uuid: rec.uuid,
      date,
      type: rec.type || 'work',
      status: rec.status || 'pending',
      // Hours are kept for employees only; subcontractors are paid on their CIS invoices
      hours: kind === 'employee' ? num(rec.hoursWorked) : null,
      site: siteOf(rec),
      notes: rec.notes || '',
      rejectionReason: rec.rejectionReason || '',
    };
    const monday = mondayOf(date);
    if (!byWeek.has(monday)) byWeek.set(monday, { monday, sunday: addDays(monday, 6), days: [], totals: emptyTotals() });
    const week = byWeek.get(monday);
    week.days.push(day);
    addTo(week.totals, day);
    addTo(totals, day);
  }
  const weeks = [...byWeek.values()].sort((a, b) => (a.monday < b.monday ? 1 : -1));
  return { person, kind, label: k.label, recordHref: `${k.recordPath}${person.uuid}`, weeks, totals, showHours: kind === 'employee' };
}

/**
 * Everyone with attendance in the range that the viewer may see, with day
 * counts, for the picker at /attendance/person. null when they can read none.
 */
export async function peopleInRange(req, range) {
  const filter = await scoped(req, { date: { $gte: range.start, $lte: range.end } });
  if (filter === null) return null;
  const groups = await mdb.INTERNAL.attendance.aggregate([
    { $match: filter },
    { $group: {
      _id: { e: '$employeeId', s: '$subcontractorId' },
      days: { $sum: 1 },
      waiting: { $sum: { $cond: [{ $in: ['$status', [...WAITING]] }, 1, 0] } },
      approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
      last: { $max: '$date' },
    } },
  ]);
  const ids = (key) => groups.map((g) => g._id[key]).filter((id) => id && mongoose.Types.ObjectId.isValid(id));
  const [employees, suppliers] = await Promise.all([
    mdb.INTERNAL.employee.find({ _id: { $in: ids('e') } }).select('_id uuid name').lean(),
    mdb.REST.supplier.find({ _id: { $in: ids('s') } }).select('_id uuid Name').lean(),
  ]);
  const emp = new Map(employees.map((e) => [String(e._id), e]));
  const sup = new Map(suppliers.map((s) => [String(s._id), s]));
  const people = [];
  for (const g of groups) {
    const e = g._id.e && emp.get(String(g._id.e));
    const s = !e && g._id.s && sup.get(String(g._id.s));
    const p = e ? { kind: 'employee', uuid: e.uuid, name: e.name } : s ? { kind: 'subcontractor', uuid: s.uuid, name: s.Name } : null;
    if (!p?.uuid) continue;
    people.push({ ...p, label: KINDS[p.kind].label, days: g.days, waiting: g.waiting, approved: g.approved, last: g.last ? ymd(g.last) : null });
  }
  people.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return people;
}

/** The viewer's own person page, when they are an employee or subcontractor. */
export async function ownPersonPath(user) {
  if (!user) return null;
  if (user.employeeId) {
    const e = await mdb.INTERNAL.employee.findById(user.employeeId).select('uuid').lean();
    if (e?.uuid) return `/attendance/person/employee/${e.uuid}`;
  }
  if (user.subcontractorId) {
    const s = await mdb.REST.supplier.findById(user.subcontractorId).select('uuid').lean();
    if (s?.uuid) return `/attendance/person/subcontractor/${s.uuid}`;
  }
  return null;
}

export default { KINDS, TYPE_LABELS, STATUS_LABELS, rangeFrom, personHistory, peopleInRange, ownPersonPath, DAY_MS };
