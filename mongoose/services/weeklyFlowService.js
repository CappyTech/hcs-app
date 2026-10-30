// Weekly attendance flow: one payroll week (Saturday to Friday), done in order.
//
//   1. Contracts   — the jobs running this week, each linked to its KashFlow project
//   2. Assignments — who (employees, subcontractors) is on which contract this week
//   3. Attendance  — the days each assigned person actually worked
//   4. Review      — what is missing or doesn't line up, then approve
//
// The /weekly grid stays the place for one-off edits (sick, holiday, pay
// rates); this page walks the week from plan to approved attendance.
//
// Holidays: approved holiday requests are the record of leave (approving one
// adds to the employee's taken days), so the flow never writes holiday
// attendance. It reads the requests and blocks work on those days instead.
// Bank and company holidays are shown and start unticked, but can be worked.
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import mongoose from 'mongoose';
import logger from '../../services/loggerService.js';
import mdb from './mongooseDatabaseService.js';
import attendanceService from './attendanceService.js';
import { HMRC_VERIFICATION_REGEX } from '../../services/cisService.js';

const OPEN_STATUSES = ['Planned', 'In Progress'];
const id = (x) => (x == null ? null : String(x._id || x));
const TZ = 'Europe/London';
const ymd = (d) => formatInTimeZone(new Date(d), TZ, 'yyyy-MM-dd');
/** London midnight at the start of a day key, and the last instant of that day. */
const dayStart = (key) => fromZonedTime(key, TZ);
const dayEnd = (key) => fromZonedTime(`${key}T23:59:59.999`, TZ);

/** Strict "YYYY-MM-DD" to server-local midnight, as the inline cell editor stores dates. */
function parseYMDLocal(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** Monday to Friday of a payroll week's day keys. */
function isWeekday(dayKey) {
  const dow = new Date(`${dayKey}T12:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Does an open contract run at any point in [weekStart, weekEnd] (yyyy-MM-dd)? */
function contractRunsInWeek(contract, weekStart, weekEnd) {
  if (!contract || !OPEN_STATUSES.includes(contract.status)) return false;
  if (contract.startDate && ymd(contract.startDate) > weekEnd) return false;
  if (contract.endDate && ymd(contract.endDate) < weekStart) return false;
  return true;
}

/** A day's hours from the employee's contract terms, to the nearest quarter hour, or null. */
function defaultDailyHours(employee) {
  const perWeek = Number(employee?.contract?.hoursPerWeek);
  const days = Number(employee?.contract?.workingDaysPerWeek);
  if (!(perWeek > 0) || !(days > 0)) return null;
  return Math.round((perWeek / days) * 4) / 4;
}

const personKey = (kind, mongoId) => `${kind === 'employee' ? 'e' : 's'}:${mongoId}`;

const LEAVE_LABELS = { annual: 'On holiday', unpaid: 'Unpaid leave', other: 'On leave' };
const WORK_TYPES = ['work', 'training'];
const isWorkType = (rec) => WORK_TYPES.includes(rec.type || 'work');

/**
 * Days of `days` covered by approved holiday requests, per employee:
 * employee _id -> Map(day -> { label, uuid }).
 */
function leaveDaysByEmployee(days, requests = []) {
  const out = new Map();
  for (const r of requests) {
    const empId = id(r.employeeId);
    if (!empId || !r.startDate || !r.endDate) continue;
    const from = ymd(r.startDate);
    const to = ymd(r.endDate);
    for (const day of days) {
      if (day < from || day > to) continue;
      if (!out.has(empId)) out.set(empId, new Map());
      out.get(empId).set(day, { label: LEAVE_LABELS[r.leaveType] || LEAVE_LABELS.other, uuid: r.uuid || null });
    }
  }
  return out;
}

/**
 * Turn one week's raw records into the four steps. Pure: everything it needs is
 * passed in, so the checks can be tested without a database.
 *
 * @param {object} p
 * @param {string[]} p.days            7 yyyy-MM-dd keys, Saturday first
 * @param {object[]} p.contracts       open contracts (lean)
 * @param {Map}      p.projectsById    REST project _id → { uuid, Number, Name }
 * @param {object[]} p.assignments     this week's assignments (lean, ids not populated)
 * @param {object[]} p.attendance      this week's attendance (lean, ids not populated)
 * @param {Map}      p.employeesById   employee _id → { _id, uuid, name, contract }
 * @param {Map}      p.suppliersById   supplier _id → { _id, uuid, Name }
 * @param {object[]} [p.leave]         approved holiday requests overlapping the week
 * @param {Map}      [p.closures]      day → title, for bank and company holidays
 */
function buildWeekFlow({ days, contracts, projectsById, assignments, attendance, employeesById, suppliersById, leave = [], closures = new Map() }) {
  const weekStart = days[0];
  const weekEnd = days[days.length - 1];

  // ── People and the records they have this week ──
  const leaveByEmployee = leaveDaysByEmployee(days, leave);
  const people = new Map();
  const person = (kind, mongoId) => {
    const key = personKey(kind, mongoId);
    if (!people.has(key)) {
      const doc = kind === 'employee' ? employeesById.get(mongoId) : suppliersById.get(mongoId);
      people.set(key, {
        key,
        kind,
        mongoId,
        uuid: doc?.uuid || null,
        name: (kind === 'employee' ? doc?.name : doc?.Name) || '(removed)',
        defaultHours: kind === 'employee' ? defaultDailyHours(doc) : null,
        recordsByDay: {},
        leaveByDay: kind === 'employee' ? leaveByEmployee.get(mongoId) || new Map() : new Map(),
        assignmentUuids: [],
      });
    }
    return people.get(key);
  };

  const counts = { pending: 0, approved: 0, rejected: 0, total: 0 };
  const recordsWithoutContract = [];
  for (const rec of attendance) {
    const kind = rec.employeeId ? 'employee' : 'subcontractor';
    const mongoId = id(rec.employeeId || rec.subcontractorId);
    if (!mongoId) continue;
    const p = person(kind, mongoId);
    const day = ymd(rec.date);
    (p.recordsByDay[day] ||= []).push(rec);
    counts.total++;
    counts[rec.status || 'pending'] = (counts[rec.status || 'pending'] || 0) + 1;
    if (isWorkType(rec) && !rec.contractId) recordsWithoutContract.push({ person: p, day, rec });
  }

  // ── Step 1: contracts running this week ──
  const running = contracts
    .filter((c) => contractRunsInWeek(c, weekStart, weekEnd))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const runningIds = new Set(running.map((c) => id(c)));

  const contractRows = running.map((c) => {
    const project = c.projectId ? projectsById.get(id(c.projectId)) || null : null;
    const warnings = [];
    if (!c.projectId) warnings.push('No KashFlow project linked');
    else if (!project) warnings.push('Linked KashFlow project no longer exists');
    if (c.status === 'Planned' && c.startDate && ymd(c.startDate) <= weekEnd) warnings.push('Still marked Planned but has started');
    if (c.endDate && ymd(c.endDate) < weekEnd) warnings.push('Ends during this week');
    return { contract: c, project, warnings, assignments: [] };
  });
  const contractRowById = new Map(contractRows.map((r) => [id(r.contract), r]));
  const contractById = new Map(contracts.map((c) => [id(c), c]));

  // ── Step 2 + 3: assignments, with a day grid of their people ──
  const assignmentRows = [];
  for (const a of assignments) {
    const contract = contractById.get(id(a.contractId)) || null;
    const members = [
      ...(a.assignedEmployees || []).map((e) => person('employee', id(e))),
      ...(a.assignedSubcontractors || []).map((s) => person('subcontractor', id(s))),
    ];
    for (const m of members) if (!m.assignmentUuids.includes(a.uuid)) m.assignmentUuids.push(a.uuid);
    const row = { assignment: a, contract, members };
    assignmentRows.push(row);
    contractRowById.get(id(a.contractId))?.assignments.push(row);
  }

  // A cell can be filled when it has no record yet (the flow never overwrites)
  // and the person isn't on approved leave. Weekdays start ticked, except bank
  // and company holidays.
  const gridFor = (p) => days.map((day) => {
    const records = p.recordsByDay[day] || [];
    const leaveDay = p.leaveByDay.get(day) || null;
    const closure = closures.get(day) || null;
    const canFill = records.length === 0 && !leaveDay;
    return { day, records, weekday: isWeekday(day), leave: leaveDay, closure, canFill, suggest: canFill && isWeekday(day) && !closure };
  });
  for (const row of assignmentRows) row.grid = row.members.map((m) => ({ person: m, cells: gridFor(m) }));

  // ── Step 4: checks ──
  const assigned = [...people.values()].filter((p) => p.assignmentUuids.length);
  const weekdays = days.filter(isWeekday);
  const workOnLeave = [];
  for (const p of people.values()) {
    for (const [day, recs] of Object.entries(p.recordsByDay)) {
      if (p.leaveByDay.has(day) && recs.some(isWorkType)) workOnLeave.push({ person: p, day });
    }
  }
  const checks = [
    {
      key: 'noProject',
      severity: 'warning',
      label: 'Contracts without a KashFlow project',
      hint: 'Their costs and income can\'t be matched to a job in KashFlow.',
      items: contractRows.filter((r) => !r.project).map((r) => ({ label: r.contract.title, href: `/contract/update/${r.contract.uuid}` })),
    },
    {
      key: 'noAssignment',
      severity: 'warning',
      label: 'Contracts running with nobody assigned this week',
      hint: 'Assign people, or mark the contract Completed if the job has finished.',
      items: contractRows.filter((r) => !r.assignments.some((a) => a.members.length)).map((r) => ({ label: r.contract.title, href: `/contract/update/${r.contract.uuid}` })),
    },
    {
      key: 'assignedNoAttendance',
      severity: 'critical',
      label: 'Assigned but no attendance on any weekday',
      hint: 'Record the days they worked, or sick or off on the weekly grid. Approved holiday counts.',
      items: assigned
        .filter((p) => !weekdays.some((d) => (p.recordsByDay[d] || []).length || p.leaveByDay.has(d)))
        .map((p) => ({ label: p.name })),
    },
    {
      key: 'notAssigned',
      severity: 'warning',
      label: 'Attendance from people not on any assignment',
      hint: 'Add them to the assignment they worked on so the hours land on the right job. Holiday, sick and off days need no assignment.',
      items: [...people.values()]
        .filter((p) => !p.assignmentUuids.length && Object.values(p.recordsByDay).flat().some(isWorkType))
        .map((p) => ({ label: p.name })),
    },
    {
      key: 'workOnLeave',
      severity: 'critical',
      label: 'Work recorded on an approved holiday',
      hint: 'Delete the work on the weekly grid, or cancel the holiday request if they came in.',
      items: workOnLeave.map(({ person: p, day }) => ({ label: `${p.name}, ${day}` })),
    },
    {
      key: 'noContract',
      severity: 'warning',
      label: 'Work recorded without a contract',
      hint: 'Pick the contract on the weekly grid so the day is costed to a job.',
      items: recordsWithoutContract.map(({ person: p, day }) => ({ label: `${p.name}, ${day}` })),
    },
    {
      key: 'closedContract',
      severity: 'warning',
      label: 'Assignments on contracts not running this week',
      hint: 'The contract is completed, or its dates are outside this week.',
      items: assignmentRows.filter((r) => !runningIds.has(id(r.assignment.contractId))).map((r) => ({ label: `${r.assignment.title} (${r.contract?.title || 'removed contract'})`, href: `/assignment/update/${r.assignment.uuid}` })),
    },
  ];

  const openChecks = checks.filter((c) => c.items.length);
  const steps = [
    { n: 1, key: 'contracts', label: 'Contracts', done: contractRows.length > 0 && !checks[0].items.length,
      summary: `${contractRows.length} running` },
    { n: 2, key: 'assignments', label: 'Assignments', done: contractRows.length > 0 && !checks[1].items.length,
      summary: `${assignmentRows.length} this week, ${assigned.length} people` },
    { n: 3, key: 'attendance', label: 'Attendance', done: assigned.length > 0 && !checks[2].items.length,
      summary: `${counts.total} records` },
    { n: 4, key: 'review', label: 'Review & approve', done: counts.total > 0 && counts.pending === 0 && !openChecks.length,
      summary: counts.pending ? `${counts.pending} pending` : openChecks.length ? `${openChecks.length} to check` : 'Nothing outstanding' },
  ];

  return {
    contracts: contractRows,
    assignments: assignmentRows,
    unassignedPeople: [...people.values()].filter((p) => !p.assignmentUuids.length && Object.values(p.recordsByDay).flat().some(isWorkType)),
    closures,
    checks,
    openChecks,
    counts,
    steps,
  };
}

// ── Database ──────────────────────────────────────────────────────────────

function fetchWeekAssignments(days) {
  // Same window as the weekly grid; ids left unpopulated (people live in two namespaces)
  return mdb.INTERNAL.assignment
    .find({ weekStart: { $gte: dayStart(days[0]), $lte: dayEnd(days[0]) } })
    .sort({ title: 1 })
    .lean();
}

/** Approved holiday requests that touch any day of the week. */
function fetchApprovedLeave(days) {
  return mdb.INTERNAL.holidayRequest
    .find({ status: 'approved', startDate: { $lte: dayEnd(days[6]) }, endDate: { $gte: dayStart(days[0]) } })
    .select('uuid employeeId startDate endDate leaveType').lean();
}

/** Bank holidays (England and Wales, as elsewhere in the app) and company holidays: day → title. */
async function fetchClosures(days) {
  const [bank, company] = await Promise.all([
    mdb.INTERNAL.holiday.find({ division: 'england-and-wales', date: { $gte: days[0], $lte: days[6] } }).select('date title').lean(),
    mdb.INTERNAL.holidayCustom.find({ date: { $gte: dayStart(days[0]), $lte: dayEnd(days[6]) } }).select('date title').lean(),
  ]);
  const out = new Map();
  for (const h of bank) out.set(h.date, h.title);
  for (const h of company) if (!out.has(ymd(h.date))) out.set(ymd(h.date), h.title);
  return out;
}

/** Everything the flow page shows for one payroll week. */
async function loadWeek(yearParam, weekParam) {
  const week = attendanceService.resolvePayrollWeek(yearParam, weekParam);
  const { days } = week;

  const [contracts, assignments, attendance, employees, lockedRun] = await Promise.all([
    mdb.INTERNAL.contract.find({ status: { $in: OPEN_STATUSES } })
      .select('_id uuid title location status startDate endDate projectId locationId').lean(),
    fetchWeekAssignments(week.days),
    mdb.INTERNAL.attendance.find({ date: { $gte: dayStart(days[0]), $lte: dayEnd(days[6]) } })
      .select('_id uuid date type status employeeId subcontractorId contractId projectId hoursWorked dayRate contractAssignmentId').lean(),
    mdb.INTERNAL.employee.find({ status: 'active' }).select('_id uuid name contract').sort({ name: 1 }).lean(),
    attendanceService.getLockedRunForDate(week.payrollWeekStart),
  ]);
  const [leave, closures] = await Promise.all([fetchApprovedLeave(days), fetchClosures(days)]);

  // Contracts referenced by assignments may be completed: fetch those too so names resolve
  const extraContractIds = [...new Set(assignments.map((a) => id(a.contractId)))]
    .filter((cid) => cid && !contracts.some((c) => id(c) === cid));
  if (extraContractIds.length) {
    contracts.push(...await mdb.INTERNAL.contract.find({ _id: { $in: extraContractIds } })
      .select('_id uuid title location status startDate endDate projectId locationId').lean());
  }

  const employeesById = new Map(employees.map((e) => [id(e), e]));
  const missingEmployeeIds = [...new Set([
    ...attendance.map((r) => id(r.employeeId)),
    ...assignments.flatMap((a) => (a.assignedEmployees || []).map(id)),
  ])].filter((eid) => eid && !employeesById.has(eid));
  if (missingEmployeeIds.length) {
    for (const e of await mdb.INTERNAL.employee.find({ _id: { $in: missingEmployeeIds } }).select('_id uuid name contract').lean()) {
      employeesById.set(id(e), e);
    }
  }

  const projectIds = [...new Set(contracts.map((c) => id(c.projectId)).filter(Boolean))];
  const supplierIds = [...new Set([
    ...attendance.map((r) => id(r.subcontractorId)),
    ...assignments.flatMap((a) => (a.assignedSubcontractors || []).map(id)),
  ].filter(Boolean))];
  const [projects, suppliers, subcontractorChoices] = await Promise.all([
    projectIds.length ? mdb.REST.project.find({ _id: { $in: projectIds } }).select('_id uuid Number Name Status').lean() : [],
    supplierIds.length ? mdb.REST.supplier.find({ _id: { $in: supplierIds } }).select('_id uuid Name').lean() : [],
    listSubcontractors(),
  ]);

  const flow = buildWeekFlow({
    days,
    contracts,
    projectsById: new Map(projects.map((p) => [id(p), p])),
    assignments,
    attendance,
    employeesById,
    suppliersById: new Map(suppliers.map((s) => [id(s), s])),
    leave,
    closures,
  });

  return { week, flow, lockedRun, employees, subcontractors: subcontractorChoices };
}

/** CIS-verified subcontractors, the same set the weekly grid lists. */
function listSubcontractors() {
  return mdb.REST.supplier.find({
    WithholdingTaxReferences: { $elemMatch: { Name: 'Verification Number', Value: { $regex: HMRC_VERIFICATION_REGEX } } },
  }).select('_id uuid Name').sort({ Name: 1 }).lean();
}

const toIds = (v) => [].concat(v || []).map(String).filter((s) => mongoose.Types.ObjectId.isValid(s));

/** Create one assignment for a contract in this week. Returns the new assignment. */
async function createAssignment(yearParam, weekParam, { contractUuid, title, employees, subcontractors, estimatedHours }) {
  const week = attendanceService.resolvePayrollWeek(yearParam, weekParam);
  const contract = await mdb.INTERNAL.contract.findOne({ uuid: String(contractUuid || '') }).select('_id title').lean();
  if (!contract) throw Object.assign(new Error('Contract not found.'), { status: 400 });
  const doc = {
    contractId: contract._id,
    weekStart: parseYMDLocal(week.days[0]),
    title: String(title || '').trim() || contract.title,
    assignedEmployees: toIds(employees),
    assignedSubcontractors: toIds(subcontractors),
    status: 'Planned',
  };
  const hours = Number(estimatedHours);
  if (estimatedHours !== undefined && estimatedHours !== '' && hours >= 0) doc.estimatedHours = hours;
  return mdb.INTERNAL.assignment.create(doc);
}

/**
 * Copy the previous week's assignments into this week, for contracts still
 * running and without an assignment of the same title already. Returns the
 * number copied.
 */
async function copyPreviousWeek(yearParam, weekParam) {
  const week = attendanceService.resolvePayrollWeek(yearParam, weekParam);
  const prev = attendanceService.resolvePayrollWeek(week.previousYear, week.previousWeek);
  const [previous, current] = await Promise.all([
    fetchWeekAssignments(prev.days),
    fetchWeekAssignments(week.days),
  ]);
  if (!previous.length) return 0;

  const contracts = await mdb.INTERNAL.contract
    .find({ _id: { $in: [...new Set(previous.map((a) => id(a.contractId)))] } })
    .select('_id status startDate endDate').lean();
  const running = new Set(contracts.filter((c) => contractRunsInWeek(c, week.days[0], week.days[6])).map(id));
  const have = new Set(current.map((a) => `${id(a.contractId)}|${a.title}`));

  const weekStart = parseYMDLocal(week.days[0]);
  const copies = previous
    .filter((a) => running.has(id(a.contractId)) && !have.has(`${id(a.contractId)}|${a.title}`))
    .map((a) => ({
      contractId: a.contractId,
      weekStart,
      title: a.title,
      description: a.description,
      assignedEmployees: a.assignedEmployees || [],
      assignedSubcontractors: a.assignedSubcontractors || [],
      estimatedHours: a.estimatedHours,
      status: 'Planned',
    }));
  if (copies.length) await mdb.INTERNAL.assignment.insertMany(copies);
  return copies.length;
}

/**
 * Record ticked days for an assignment's people as pending work attendance,
 * costed to the assignment's contract and its KashFlow project.
 *
 * @param {object} input
 * @param {string} input.assignmentUuid
 * @param {object} input.days   personKey → day key or list of day keys
 * @param {object} input.hours  personKey → hours per day (employees)
 * @param {boolean} input.isAdmin  admins may correct locked payroll periods
 * @returns {Promise<{ created: number, skipped: string[] }>}
 */
async function recordAttendance(yearParam, weekParam, { assignmentUuid, days = {}, hours = {}, isAdmin = false }) {
  const week = attendanceService.resolvePayrollWeek(yearParam, weekParam);
  const assignment = await mdb.INTERNAL.assignment.findOne({ uuid: String(assignmentUuid || '') }).lean();
  if (!assignment) throw Object.assign(new Error('Assignment not found.'), { status: 400 });
  if (ymd(assignment.weekStart) !== week.days[0]) throw Object.assign(new Error('That assignment is for a different week.'), { status: 400 });
  const contract = await mdb.INTERNAL.contract.findById(assignment.contractId).select('_id projectId locationId').lean();

  const members = new Map([
    ...(assignment.assignedEmployees || []).map((e) => [personKey('employee', id(e)), { employeeId: e }]),
    ...(assignment.assignedSubcontractors || []).map((s) => [personKey('subcontractor', id(s)), { subcontractorId: s }]),
  ]);

  // Approved holiday: never record work over it
  const leaveByEmployee = leaveDaysByEmployee(week.days, await fetchApprovedLeave(week.days));

  const docs = [];
  const skipped = [];
  for (const [key, ticked] of Object.entries(days || {})) {
    const who = members.get(key);
    if (!who) continue; // not on this assignment: ignore rather than trust the form
    const dayKeys = [...new Set([].concat(ticked || []).map(String))].filter((d) => week.days.includes(d));
    if (!dayKeys.length) continue;

    // Never overwrite: skip any day that already has a record for this person
    const existing = await mdb.INTERNAL.attendance.find({
      ...who,
      date: { $gte: dayStart(week.days[0]), $lte: dayEnd(week.days[6]) },
    }).select('date').lean();
    const taken = new Set(existing.map((r) => ymd(r.date)));
    if (who.employeeId) for (const day of leaveByEmployee.get(id(who.employeeId))?.keys() || []) taken.add(day);

    const h = Number(hours?.[key]);
    for (const day of dayKeys) {
      if (taken.has(day)) { skipped.push(day); continue; }
      const date = parseYMDLocal(day);
      if (!isAdmin && await attendanceService.getLockedRunForDate(date)) { skipped.push(day); continue; }
      const doc = {
        ...who,
        date,
        type: 'work',
        status: 'pending',
        contractId: assignment.contractId,
        contractAssignmentId: assignment._id,
      };
      if (contract?.projectId) doc.projectId = contract.projectId;
      if (contract?.locationId) doc.locationId = contract.locationId;
      if (who.employeeId && h > 0 && h <= 24) doc.hoursWorked = h;
      docs.push(doc);
    }
  }

  let created = 0;
  if (docs.length) {
    try {
      created = (await mdb.INTERNAL.attendance.insertMany(docs, { ordered: false })).length;
    } catch (err) {
      // A duplicate from a concurrent save: keep the rows that went in
      if (err.code !== 11000 && !err.writeErrors) throw err;
      created = err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
      logger.warn(`[weeklyFlowService] ${docs.length - created} attendance rows already existed`);
    }
  }
  return { created, skipped };
}

export default {
  isWeekday,
  contractRunsInWeek,
  defaultDailyHours,
  personKey,
  buildWeekFlow,
  loadWeek,
  createAssignment,
  copyPreviousWeek,
  recordAttendance,
};

export { isWeekday, contractRunsInWeek, defaultDailyHours, personKey, buildWeekFlow, loadWeek, createAssignment, copyPreviousWeek, recordAttendance };
