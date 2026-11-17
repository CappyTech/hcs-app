// Weekly sheet: the WEEKLY ATTENDANCE spreadsheet as one page.
//
// One row per person, Monday to Sunday, each cell saying where they were:
// a contract (site), a saved location (Office), Off or Sick. Saving writes
// planned attendance records: the person confirms each day once it comes, or
// the Site Manager marks it attended, and it goes on through approval as
// usual (attendanceApprovalService). Payroll reads only approved days. Beside the grid, as on the spreadsheet:
// the contracts running, the jobs for allocation and the vehicle dates.
//
// Rules, kept from the weekly flow (weeklyFlowService):
//   - approved holiday requests are the record of leave; the sheet shows them
//     and never writes holiday attendance over them
//   - only planned, pending or rejected records can be changed here; a
//     changed confirmed (pending) day stays pending, anything else goes back
//     to planned; anything signed
//     off, or with more than one record that day, is shown and left alone
//   - days in a locked payroll period can't be changed, except by an admin
//
// buildSheet and the helpers above it are pure, for testing without a database.
import mongoose from 'mongoose';
import logger from '../../services/loggerService.js';
import mdb from './mongooseDatabaseService.js';
import attendanceService from './attendanceService.js';
import jobRegisterService from './jobRegisterService.js';
import personNotices from './personNoticeService.js';
import {
  contractRunsInWeek, defaultDailyHours, personKey, leaveDaysByEmployee, fetchApprovedLeave,
  fetchClosures, parseYMDLocal, dayStart, dayEnd, ymd,
} from './weeklyFlowService.js';

const TZ_NOON = (key) => new Date(`${key}T12:00:00Z`);
const id = (x) => (x == null ? null : String(x._id || x));
const EDITABLE_STATUSES = ['planned', 'pending', 'rejected'];
const RECENT_SUBCONTRACTOR_WEEKS = 4;
const VEHICLE_WARN_DAYS = 30;

export const GROUPS = [
  { key: 'office', label: 'Office' },
  { key: 'landscaping', label: 'Landscaping' },
  { key: 'other', label: 'Other staff' },
  { key: 'sub', label: 'Sub-contract' },
];
const DEPARTMENT_GROUP = { Office: 'office', Landscaping: 'landscaping' };
export const TYPE_CHOICES = [{ value: 'off', label: 'Off' }, { value: 'sick', label: 'Sick' }];
const TYPE_LABELS = { off: 'Off', sick: 'Sick', holiday: 'Holiday', leave: 'Leave', training: 'Training', work: 'Work' };

/** yyyy-MM-dd plus n days. */
export function addDays(key, n) {
  return new Date(TZ_NOON(key).getTime() + n * 864e5).toISOString().slice(0, 10);
}

/** The Monday on or before a yyyy-MM-dd day key. */
export function mondayOf(key) {
  const dow = TZ_NOON(key).getUTCDay();
  return addDays(key, -((dow + 6) % 7));
}

/** The week for /weekly-sheet/:monday?: any day in the week works; no day means this week. */
export function resolveWeek(param, today = ymd(new Date())) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(param || '')) && !Number.isNaN(TZ_NOON(param).getTime())
    && TZ_NOON(param).toISOString().slice(0, 10) === param;
  const monday = mondayOf(valid ? param : today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { monday, days, previous: addDays(monday, -7), next: addDays(monday, 7), thisWeek: mondayOf(today), today };
}

/** The cell value of one attendance record, or null if the sheet can't edit it. */
export function cellValueOf(rec) {
  const type = rec.type || 'work';
  if (type === 'off' || type === 'sick') return type;
  if (type === 'work') {
    if (rec.contractId) return `con:${id(rec.contractId)}`;
    if (rec.locationId) return `loc:${id(rec.locationId)}`;
  }
  return null;
}

/** Days left this holiday year from an employeeHoliday record, in days, or null. */
export function holidayLeft(h) {
  if (!h || (h.entitlementType && h.entitlementType !== 'days')) return null;
  const base = h.accrualMethod && h.accrualMethod !== 'fixed' ? h.accruedDays : h.entitlementDays;
  if (base == null) return null;
  return Math.round(((Number(base) || 0) + (Number(h.carryOverDays) || 0) - (Number(h.takenDays) || 0)) * 10) / 10;
}

/** 'overdue' | 'soon' | 'ok' | null for a vehicle's expiry date. */
export function dueState(date, today) {
  if (!date) return null;
  const key = ymd(date);
  if (key < today) return 'overdue';
  if (key <= addDays(today, VEHICLE_WARN_DAYS)) return 'soon';
  return 'ok';
}

/**
 * The grid, its choices and its side panels. Pure.
 *
 * @param {object} p
 * @param {object}   p.week            from resolveWeek
 * @param {object[]} p.employees       active employees (lean)
 * @param {object[]} p.subcontractors  suppliers to show as rows (lean)
 * @param {object[]} p.attendance      this week's attendance (lean, ids unpopulated)
 * @param {object[]} p.contracts       contracts (lean): open ones plus any the week's records use
 * @param {object[]} p.locations       saved locations (lean)
 * @param {object[]} [p.leave]         approved holiday requests overlapping the week
 * @param {Map}      [p.closures]      day → bank or company holiday title
 * @param {Set}      [p.lockedDays]    days in a locked payroll period
 * @param {Map}      [p.holidays]      employee _id → employeeHoliday for the current year
 * @param {boolean}  [p.isAdmin]
 * @param {string}   [p.group]         one of GROUPS' keys, or '' for everyone
 */
export function buildSheet({
  week, employees, subcontractors, attendance, contracts, locations,
  leave = [], closures = new Map(), lockedDays = new Set(), holidays = new Map(), isAdmin = false, group = '',
}) {
  const { days } = week;
  const contractById = new Map(contracts.map((c) => [id(c), c]));
  const locationById = new Map(locations.map((l) => [id(l), l]));
  const leaveByEmployee = leaveDaysByEmployee(days, leave);

  // Choices: contracts running this week, then saved locations, then Off/Sick
  const running = contracts
    .filter((c) => contractRunsInWeek(c, days[0], days[6]))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const choices = [
    ...running.map((c) => ({ value: `con:${id(c)}`, label: c.title, group: 'Sites' })),
    ...[...locations].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .filter((l) => l.name).map((l) => ({ value: `loc:${id(l)}`, label: l.name, group: 'Locations' })),
    ...TYPE_CHOICES.map((t) => ({ ...t, group: 'Other' })),
  ];
  const choiceValues = new Set(choices.map((c) => c.value));

  const labelOf = (rec) => {
    const type = rec.type || 'work';
    if (type === 'work' || type === 'training') {
      const place = contractById.get(id(rec.contractId))?.title || locationById.get(id(rec.locationId))?.name;
      return type === 'training' ? `Training${place ? ` (${place})` : ''}` : (place || 'Work');
    }
    return TYPE_LABELS[type] || type;
  };

  const byPerson = new Map();
  for (const rec of attendance) {
    const kind = rec.employeeId ? 'employee' : 'subcontractor';
    const key = personKey(kind, id(rec.employeeId || rec.subcontractorId));
    const day = ymd(rec.date);
    const m = byPerson.get(key) || new Map();
    (m.get(day) || m.set(day, []).get(day)).push(rec);
    byPerson.set(key, m);
  }

  const cellsFor = (key, kind, mongoId) => days.map((day) => {
    const records = byPerson.get(key)?.get(day) || [];
    const leaveDay = kind === 'employee' ? leaveByEmployee.get(mongoId)?.get(day) : null;
    const base = { day, closure: closures.get(day) || null, records };
    if (leaveDay) return { ...base, editable: false, label: leaveDay.label, tone: 'leave', value: '' };
    if (lockedDays.has(day) && !isAdmin) {
      return { ...base, editable: false, label: records.length ? records.map(labelOf).join(', ') : 'Payroll locked', tone: 'locked', value: '' };
    }
    if (records.length > 1) return { ...base, editable: false, label: `${records.length} entries`, tone: 'multi', value: '' };
    if (records.length === 1) {
      const rec = records[0];
      const value = cellValueOf(rec);
      const status = rec.status || 'pending';
      if (!value || !EDITABLE_STATUSES.includes(status)) {
        return { ...base, editable: false, label: labelOf(rec), tone: status === 'approved' || status === 'site-approved' ? 'approved' : 'other', status, value: '' };
      }
      // A record on a contract that's no longer offered: show it as a choice so saving doesn't change it
      const extra = choiceValues.has(value) ? null : { value, label: labelOf(rec), group: 'Current' };
      return { ...base, editable: true, value, status, extra, label: labelOf(rec) };
    }
    return { ...base, editable: true, value: '', label: '' };
  });

  const rows = [];
  for (const e of employees) {
    const key = personKey('employee', id(e));
    const h = holidays.get(id(e)) || null;
    rows.push({
      key, kind: 'employee', mongoId: id(e), uuid: e.uuid, name: e.name,
      group: DEPARTMENT_GROUP[e.department] || 'other',
      holidayLeft: holidayLeft(h), holidayRenews: h?.periodEnd || null,
      cells: cellsFor(key, 'employee', id(e)),
    });
  }
  for (const s of subcontractors) {
    const key = personKey('subcontractor', id(s));
    rows.push({ key, kind: 'subcontractor', mongoId: id(s), uuid: s.uuid, name: s.Name || '(no name)', group: 'sub', holidayLeft: null, cells: cellsFor(key, 'subcontractor', id(s)) });
  }

  const counts = Object.fromEntries(GROUPS.map((g) => [g.key, rows.filter((r) => r.group === g.key).length]));
  const shown = group && GROUPS.some((g) => g.key === group) ? rows.filter((r) => r.group === group) : rows;
  const sections = GROUPS.map((g) => ({ ...g, rows: shown.filter((r) => r.group === g.key).sort((a, b) => String(a.name).localeCompare(String(b.name))) }))
    .filter((s) => s.rows.length);

  return { sections, counts, total: rows.length, allRows: rows, choices, running, group: shown === rows ? '' : group };
}

/**
 * Which cells a save should change: those whose submitted value differs
 * from the value the form was drawn with. Pure.
 * body: { cell: { [personKey]: { [day]: value } }, was: { ...same } }
 */
export function changedCells(body = {}, days = []) {
  const out = [];
  const cell = body.cell && typeof body.cell === 'object' ? body.cell : {};
  const was = body.was && typeof body.was === 'object' ? body.was : {};
  for (const [key, perDay] of Object.entries(cell)) {
    if (!/^[es]:[0-9a-f]{24}$/.test(key) || !perDay || typeof perDay !== 'object') continue;
    for (const [day, raw] of Object.entries(perDay)) {
      if (!days.includes(day)) continue;
      const value = String(raw ?? '');
      const before = String(was?.[key]?.[day] ?? '');
      if (value !== before) out.push({ key, day, value, before });
    }
  }
  return out;
}

// ── Database ────────────────────────────────────────────────────────────

const CONTRACT_FIELDS = '_id uuid title location status startDate endDate projectId locationId';

async function fetchLockedDays(days) {
  const runs = await Promise.all(days.map((d) => attendanceService.getLockedRunForDate(parseYMDLocal(d))));
  return new Set(days.filter((_, i) => runs[i]));
}

async function fetchCurrentHolidays(employeeIds) {
  if (!employeeIds.length || !mdb.INTERNAL.employeeHoliday) return new Map();
  const now = new Date();
  const docs = await mdb.INTERNAL.employeeHoliday
    .find({ employeeId: { $in: employeeIds }, periodStart: { $lte: now }, periodEnd: { $gte: now } })
    .select('employeeId periodEnd entitlementType entitlementDays accruedDays carryOverDays takenDays accrualMethod').lean();
  return new Map(docs.map((d) => [id(d.employeeId), d]));
}

/**
 * "Copy from yesterday" on one person's day: the form as it stands (submitted
 * cells, else what's saved), with that person's place on the day before put
 * into `day`, if that cell can be edited and the place is on offer. A day
 * before that can't be edited (signed off, say) still copies its single
 * record's place; an empty one copies nothing. Pure; nothing is saved.
 * Returns { draft: { [personKey]: { [day]: value } }, copied, from }.
 */
export function copyFromYesterday({ rows = [], days = [], person, day, cells = {}, allowed = new Set() }) {
  const i = days.indexOf(day);
  if (i < 1) return { draft: {}, copied: 0, from: null };
  const from = days[i - 1];
  const draft = {};
  let copied = 0;
  for (const row of rows) {
    const submitted = cells && typeof cells === 'object' ? cells[row.key] || {} : {};
    const rowDraft = {};
    for (const c of row.cells) {
      if (c.editable) rowDraft[c.day] = submitted[c.day] !== undefined ? String(submitted[c.day]) : c.value;
    }
    draft[row.key] = rowDraft;
    if (row.key !== person) continue;
    const before = row.cells.find((c) => c.day === from);
    const target = row.cells.find((c) => c.day === day);
    let value = '';
    if (before?.editable) value = rowDraft[from] || '';
    else if (before?.records?.length === 1) value = cellValueOf(before.records[0]) || '';
    if (target?.editable && value && (allowed.has(value) || value === target.extra?.value)) {
      if (rowDraft[day] !== value) copied++;
      rowDraft[day] = value;
    }
  }
  return { draft, copied, from };
}

// ── Who's on the sheet ──────────────────────────────────────────────────

/**
 * The people on a week's sheet. Pure.
 *   defaults     personKeys shown without any change (active employees,
 *                subcontractors with recent attendance)
 *   overrides    { added, removed } in force for the week (its own, or the
 *                nearest earlier week's), or null
 *   withRecords  personKeys with attendance this week: always shown
 */
export function effectivePeople({ defaults = [], overrides = null, withRecords = [] }) {
  const removed = new Set(overrides?.removed || []);
  const out = new Set([...defaults, ...(overrides?.added || [])].filter((k) => !removed.has(k)));
  for (const k of withRecords) out.add(k);
  return out;
}

/** Overrides after adding or removing one person. Pure. */
export function changeOverrides(overrides, key, action) {
  const added = new Set(overrides?.added || []);
  const removed = new Set(overrides?.removed || []);
  if (action === 'add') { removed.delete(key); added.add(key); }
  if (action === 'remove') { added.delete(key); removed.add(key); }
  return { added: [...added], removed: [...removed] };
}

/** The changes in force for a week: its own, or the nearest earlier week's. */
export async function fetchOverrides(monday) {
  if (!mdb.INTERNAL.weeklySheetPeople) return null;
  return mdb.INTERNAL.weeklySheetPeople.findOne({ monday: { $lte: monday } }).sort({ monday: -1 }).select('monday added removed').lean();
}

/**
 * Add or remove someone from a week onwards: the week gets its own copy of the
 * changes in force, with this one applied. key: 'e:<id>' | 's:<id>'.
 */
export async function changePeople(param, key, action, userId) {
  if (!/^[es]:[0-9a-f]{24}$/.test(String(key || '')) || !['add', 'remove'].includes(action)) {
    throw Object.assign(new Error('Choose someone to add or remove.'), { status: 400 });
  }
  const { monday } = resolveWeek(param);
  const next = changeOverrides(await fetchOverrides(monday), key, action);
  await mdb.INTERNAL.weeklySheetPeople.updateOne(
    { monday },
    { $set: { ...next, updatedBy: userId || undefined }, $setOnInsert: { monday } },
    { upsert: true },
  );
  return { monday, ...next };
}

/** Subcontractors with attendance this week or in the few weeks before (plus `extra`). */
async function fetchSubcontractorRows(days, extraIds = []) {
  const since = dayStart(addDays(days[0], -7 * RECENT_SUBCONTRACTOR_WEEKS));
  const recent = await mdb.INTERNAL.attendance.distinct('subcontractorId', {
    subcontractorId: { $ne: null },
    date: { $gte: since, $lte: dayEnd(days[6]) },
  });
  const ids = [...new Set([...recent.map(String), ...extraIds.filter((x) => mongoose.Types.ObjectId.isValid(x))])];
  if (!ids.length) return [];
  return mdb.REST.supplier.find({ _id: { $in: ids } }).select('_id uuid Name').lean();
}

/** Everything the sheet shows for one week. */
export async function loadSheet(param, { isAdmin = false, group = '' } = {}) {
  const week = resolveWeek(param);
  const { days } = week;
  const overrides = await fetchOverrides(week.monday);
  const [activeEmployees, attendance, openContracts, locations, leave, closures, lockedDays, recentSubs, vehicles, jobs] = await Promise.all([
    mdb.INTERNAL.employee.find({ status: 'active' }).select('_id uuid name department contract').sort({ name: 1 }).lean(),
    mdb.INTERNAL.attendance.find({ date: { $gte: dayStart(days[0]), $lte: dayEnd(days[6]) } })
      .select('_id uuid date type status employeeId subcontractorId contractId locationId projectId hoursWorked').lean(),
    mdb.INTERNAL.contract.find({ status: { $in: ['Planned', 'In Progress'] } }).select(CONTRACT_FIELDS).lean(),
    mdb.INTERNAL.location.find({}).select('_id uuid name').lean(),
    fetchApprovedLeave(days),
    fetchClosures(days),
    fetchLockedDays(days),
    fetchSubcontractorRows(days),
    mdb.INTERNAL.vehicle.find({ availabilityStatus: { $ne: 'Disposed' } })
      .select('uuid registrationNumber make model bodyType roadTaxExpiryDate motExpiryDate insuranceExpiryDate insuranceProvider breakdownExpiryDate breakdownProvider')
      .sort({ registrationNumber: 1 }).lean(),
    jobRegisterService.jobsForAllocation(),
  ]);

  // Contracts the week's records use but that are no longer open: fetch so names resolve
  const contracts = [...openContracts];
  const extra = [...new Set(attendance.map((r) => id(r.contractId)).filter(Boolean))].filter((cid) => !contracts.some((c) => id(c) === cid));
  if (extra.length) contracts.push(...await mdb.INTERNAL.contract.find({ _id: { $in: extra } }).select(CONTRACT_FIELDS).lean());

  // Who's on the sheet: the defaults with the week's changes, plus anyone with records this week
  const withRecords = attendance.map((r) => (r.employeeId ? personKey('employee', id(r.employeeId)) : personKey('subcontractor', id(r.subcontractorId))));
  const shown = effectivePeople({
    defaults: [...activeEmployees.map((e) => personKey('employee', id(e))), ...recentSubs.map((s) => personKey('subcontractor', id(s)))],
    overrides,
    withRecords,
  });
  const employees = activeEmployees.filter((e) => shown.has(personKey('employee', id(e))));
  const known = new Set(employees.map(id));
  const missing = [...shown].filter((k) => k.startsWith('e:') && !known.has(k.slice(2))).map((k) => k.slice(2));
  if (missing.length) employees.push(...await mdb.INTERNAL.employee.find({ _id: { $in: missing } }).select('_id uuid name department contract').lean());
  const subcontractors = recentSubs.filter((s) => shown.has(personKey('subcontractor', id(s))));
  const knownSubs = new Set(subcontractors.map(id));
  const missingSubs = [...shown].filter((k) => k.startsWith('s:') && !knownSubs.has(k.slice(2))).map((k) => k.slice(2));
  if (missingSubs.length) subcontractors.push(...await mdb.REST.supplier.find({ _id: { $in: missingSubs } }).select('_id uuid Name').lean());

  const holidays = await fetchCurrentHolidays(employees.map((e) => e._id));
  const projectIds = [...new Set(contracts.map((c) => id(c.projectId)).filter(Boolean))];
  const projects = projectIds.length ? await mdb.REST.project.find({ _id: { $in: projectIds } }).select('_id uuid Number Name').lean() : [];
  const projectsById = new Map(projects.map((p) => [id(p), p]));

  const sheet = buildSheet({ week, employees, subcontractors, attendance, contracts, locations, leave, closures, lockedDays, holidays, isAdmin, group });
  return {
    week,
    sheet,
    closures,
    running: sheet.running.map((c) => ({ ...c, project: projectsById.get(id(c.projectId)) || null })),
    jobs,
    vehicles: vehicles.map((v) => ({
      ...v,
      due: {
        tax: dueState(v.roadTaxExpiryDate, week.today),
        mot: dueState(v.motExpiryDate, week.today),
        insurance: dueState(v.insuranceExpiryDate, week.today),
        breakdown: dueState(v.breakdownExpiryDate, week.today),
      },
    })),
    overrides,
    employeesById: new Map(employees.map((e) => [id(e), e])),
    contractsById: new Map(contracts.map((c) => [id(c), c])),
    attendance,
  };
}

/**
 * Save the cells that changed. Each change is checked against the sheet as
 * it is now: a cell someone else changed since the form was drawn, or one
 * the sheet can't edit, is skipped and counted. Returns { saved, skipped }.
 * Each person whose days were saved is told once, listing their days
 * (personNoticeService), unless they saved it themselves (`actorId`).
 */
export async function saveSheet(param, body, { isAdmin = false, actorId = null } = {}) {
  const loaded = await loadSheet(param, { isAdmin });
  const { week } = loaded;
  const changes = changedCells(body, week.days);
  if (!changes.length) return { saved: 0, skipped: 0 };

  const applied = [];
  try {
    return await applyChanges(loaded, changes, applied);
  } finally {
    // Whatever was saved is told, even if a later cell failed. Never throws.
    if (applied.length) await personNotices.sheetSaved({ monday: week.monday, changes: applied, actorId });
  }
}

async function applyChanges({ sheet, employeesById, contractsById }, changes, applied) {
  const rowsByKey = new Map(sheet.sections.flatMap((s) => s.rows).map((r) => [r.key, r]));
  const allowed = new Set(sheet.choices.map((c) => c.value));
  const labels = new Map(sheet.choices.map((c) => [c.value, c.label]));
  let saved = 0;
  let skipped = 0;

  for (const change of changes) {
    const row = rowsByKey.get(change.key);
    const cell = row?.cells.find((c) => c.day === change.day);
    if (!cell || !cell.editable || cell.value !== change.before) { skipped++; continue; }
    const value = change.value;
    if (value && !allowed.has(value) && value !== cell.extra?.value) { skipped++; continue; }

    const who = row.kind === 'employee' ? { employeeId: row.mongoId } : { subcontractorId: row.mongoId };
    const existing = cell.records[0] ? await mdb.INTERNAL.attendance.findById(cell.records[0]._id) : null;
    // For the person's notice: what the day was and is now, and a stamp that
    // tells this change apart from an identical one made later
    const priorStamp = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : '';
    const note = (docId) => applied.push({
      key: row.key,
      day: change.day,
      beforeLabel: change.before ? cell.label : '',
      afterLabel: value ? (labels.get(value) || cell.extra?.label || value) : '',
      stamp: `${docId || ''}|${priorStamp}`,
    });
    try {
      if (!value) {
        if (existing) { await existing.deleteOne(); saved++; note(existing._id); }
        continue;
      }
      const doc = existing || new mdb.INTERNAL.attendance({ ...who, date: parseYMDLocal(change.day) });
      // A confirmed day stays confirmed; a new, planned or rejected one is (back in) the plan
      doc.status = existing?.status === 'pending' ? 'pending' : 'planned';
      for (const k of ['contractId', 'locationId', 'projectId', 'contractAssignmentId']) doc.set(k, undefined);
      if (value === 'off' || value === 'sick') {
        doc.type = value;
        doc.set('hoursWorked', undefined);
        doc.set('dayRate', undefined);
      } else {
        doc.type = 'work';
        const [kind, targetId] = value.split(':');
        if (kind === 'con') {
          const c = contractsById.get(targetId);
          doc.contractId = targetId;
          if (c?.projectId) doc.projectId = c.projectId;
          if (c?.locationId) doc.locationId = c.locationId;
        } else {
          doc.locationId = targetId;
        }
        if (row.kind === 'employee' && doc.hoursWorked == null && doc.dayRate == null) {
          const h = defaultDailyHours(employeesById.get(row.mongoId));
          if (h) doc.hoursWorked = h;
        }
      }
      await doc.save();
      saved++;
      note(doc._id);
    } catch (err) {
      if (err.code === 11000 || err.name === 'ValidationError' || /Attendance must|Work or training/.test(err.message)) {
        logger.warn(`[weeklySheetService] Skipped ${change.key} ${change.day}: ${err.message}`);
        skipped++;
        continue;
      }
      throw err;
    }
  }
  return { saved, skipped };
}

export default {
  GROUPS, TYPE_CHOICES, addDays, mondayOf, resolveWeek, cellValueOf, holidayLeft, dueState, buildSheet, changedCells, loadSheet, saveSheet,
  effectivePeople, changeOverrides, fetchOverrides, changePeople, copyFromYesterday,
};
