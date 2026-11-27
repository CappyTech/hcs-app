// Job labour and margin: what the people on a job have cost, and what's left.
//
// Labour comes from attendance. A day belongs to a job by its jobRegisterId;
// older records written before jobs had one count when they have no
// jobRegisterId and either their contractId is the job's contract (only when
// no other job shares that contract, so a day is never counted twice) or their
// projectId is the synced KashFlow project with the job's number.
//
// Only work and training days count. Rejected days are left out.
//
// Employees: an approved day costs what payroll pays for it (the same rule as
// payrollCalculationService.grossPayFromRecords): its dayRate when set, else
// hoursWorked × the hourly rate saved on the day (attendanceRateService), or
// × the employee's current hourlyRate when the day has none. Days costed at
// an estimated rate (filled in afterwards, or none saved) are counted as
// estimatedRateDays; their cost still counts. Days not approved yet (planned,
// pending, site-approved) are costed the same way but kept apart, as an
// estimate. A day with neither a day rate nor hours (or hours and no hourly
// rate) costs nothing and is counted as uncosted.
//
// Subcontractors are paid on their CIS invoices, so their days carry no pay.
// What they've cost the job is the labour lines of their purchase invoices on
// it (jobCostService lineRole), matched by supplier: attendance
// subcontractorId → REST supplier Code → purchase SupplierCode.
//
// Costs = materials + labour:
//   materials = the job's purchase lines sorted as materials
//   labour    = approved employee labour + the job's purchase lines sorted as
//               labour (subcontractors, and any other labour bought in)
// Margin = income − costs. Income is what's invoiced, or the agreed (won)
// value while nothing is invoiced yet.
//
// The helpers above "Database" are pure, so the sums can be tested without a
// database. The aggregate's rows (groupsPipeline) and groupRecords() have the
// same shape, so the job page and the register share one costing.
import mongoose from 'mongoose';
import mdb from './mongooseDatabaseService.js';
import { grossPayFromRecords, toNum, savedHourlyRate, hasEstimatedRate } from './payrollCalculationService.js';
import jobCost, { roundPence } from './jobCostService.js';

export const LABOUR_TYPES = ['work', 'training'];

const idStr = (v) => (v == null ? null : String(v._id ?? v));
const codeKey = (v) => String(v ?? '').trim().toUpperCase();

/**
 * The attendance $match for a set of jobs: work/training days, not rejected,
 * on one of the jobs (jobRegisterId), or older days with no jobRegisterId on
 * one of the contracts or projects.
 *
 * @param {{ jobIds: Array, contractIds?: Array, projectIds?: Array }} p
 */
export function attendanceMatch({ jobIds = [], contractIds = [], projectIds = [] }) {
  const or = [{ jobRegisterId: { $in: jobIds } }];
  if (contractIds.length) or.push({ jobRegisterId: { $in: [null] }, contractId: { $in: contractIds } });
  if (projectIds.length) or.push({ jobRegisterId: { $in: [null] }, projectId: { $in: projectIds } });
  return { type: { $in: LABOUR_TYPES }, status: { $ne: 'rejected' }, $or: or };
}

/**
 * One row per job link × person × approved-or-not, with the sums the costing
 * needs: days, hours, the day rates of days paid by day rate, the cost of
 * hourly days at their saved rate (savedRateCost), the hours of hourly days
 * with no saved rate (hourlyHours, costed at the employee's current rate),
 * and how many hourly days are at an estimated rate.
 */
export function groupsPipeline(match) {
  const num = (path) => ({ $convert: { input: path, to: 'double', onError: 0, onNull: 0 } });
  const byDay = { $gt: [num('$dayRate'), 0] };
  const saved = { $gt: [num('$savedRate.hourly'), 0] };
  const hasHours = { $gt: [num('$hoursWorked'), 0] };
  return [
    { $match: match },
    { $group: {
      _id: {
        job: '$jobRegisterId', contract: '$contractId', project: '$projectId',
        employee: '$employeeId', subcontractor: '$subcontractorId',
        approved: { $eq: ['$status', 'approved'] },
      },
      days: { $sum: 1 },
      hours: { $sum: num('$hoursWorked') },
      dayRateTotal: { $sum: { $cond: [byDay, num('$dayRate'), 0] } },
      savedRateCost: { $sum: { $cond: [{ $or: [byDay, { $not: [saved] }] }, 0, { $multiply: [num('$hoursWorked'), num('$savedRate.hourly')] }] } },
      hourlyHours: { $sum: { $cond: [{ $or: [byDay, saved] }, 0, num('$hoursWorked')] } },
      estimatedRateDays: { $sum: { $cond: [{ $and: [{ $not: [byDay] }, hasHours, { $or: [{ $not: [saved] }, { $eq: ['$savedRate.estimated', true] }] }] }, 1, 0] } },
      uncostedDays: { $sum: { $cond: [{ $or: [byDay, { $gt: [num('$hoursWorked'), 0] }] }, 0, 1] } },
      first: { $min: '$date' },
      last: { $max: '$date' },
    } },
  ];
}

/**
 * groupsPipeline() in JavaScript, for records already loaded (and the tests).
 * Records should already be filtered (work/training, not rejected).
 */
export function groupRecords(records = []) {
  const out = new Map();
  for (const r of records) {
    const _id = {
      job: r.jobRegisterId ?? null, contract: r.contractId ?? null, project: r.projectId ?? null,
      employee: r.employeeId ?? null, subcontractor: r.subcontractorId ?? null, approved: r.status === 'approved',
    };
    const key = [_id.job, _id.contract, _id.project, _id.employee, _id.subcontractor, _id.approved].map(String).join('|');
    const g = out.get(key) || { _id, days: 0, hours: 0, dayRateTotal: 0, savedRateCost: 0, hourlyHours: 0, estimatedRateDays: 0, uncostedDays: 0, first: null, last: null };
    const dayRate = toNum(r.dayRate);
    const hours = toNum(r.hoursWorked);
    const saved = savedHourlyRate(r);
    g.days += 1;
    g.hours += hours;
    if (dayRate > 0) g.dayRateTotal += dayRate;
    else if (saved != null) g.savedRateCost += hours * saved;
    else g.hourlyHours += hours;
    if (hasEstimatedRate(r)) g.estimatedRateDays += 1;
    if (!(dayRate > 0) && !(hours > 0)) g.uncostedDays += 1;
    const t = r.date ? new Date(r.date) : null;
    if (t && (!g.first || t < g.first)) g.first = t;
    if (t && (!g.last || t > g.last)) g.last = t;
    out.set(key, g);
  }
  return [...out.values()];
}

/**
 * What a group of an employee's days costs by the payroll rule: the day
 * rates, plus hourly days at their saved rate, plus hourly days with no saved
 * rate × the employee's current hourlyRate. Same as grossPayFromRecords() on
 * the group's records (up to rounding).
 */
export function groupCost(group, employee) {
  const rate = toNum(employee?.hourlyRate);
  return roundPence(toNum(group?.dayRateTotal) + toNum(group?.savedRateCost) + toNum(group?.hourlyHours) * rate);
}

/** Re-export of the payroll rule, so callers and tests use one definition. */
export { grossPayFromRecords };

/**
 * The job a group belongs to: its jobRegisterId; else (an older record) the
 * job whose contract it is, when only one job has that contract; else the job
 * whose KashFlow project it is. Null when none.
 *
 * @param {object} id - the group's _id
 * @param {{ jobIds: Set<string>, jobByContract: Map<string,string>, jobByProject: Map<string,string> }} index
 */
export function jobForGroup(id, { jobIds, jobByContract = new Map(), jobByProject = new Map() }) {
  const job = idStr(id?.job);
  if (job) return jobIds.has(job) ? job : null;
  const contract = idStr(id?.contract);
  if (contract && jobByContract.has(contract)) return jobByContract.get(contract);
  const project = idStr(id?.project);
  if (project && jobByProject.has(project)) return jobByProject.get(project);
  return null;
}

/**
 * The lookup jobForGroup() uses, from jobs ({ _id, contractId }) and the
 * synced project _id for each job's number. A contract shared by two or more
 * jobs is left out, so its older days count for none of them.
 */
export function jobIndex(jobs = [], projectIdByNumber = new Map()) {
  const jobIds = new Set(jobs.map((j) => idStr(j._id)));
  const contractJobs = new Map();
  for (const j of jobs) {
    const c = idStr(j.contractId);
    if (c) contractJobs.set(c, [...(contractJobs.get(c) || []), idStr(j._id)]);
  }
  const jobByContract = new Map([...contractJobs].filter(([, list]) => list.length === 1).map(([c, list]) => [c, list[0]]));
  const jobByProject = new Map();
  for (const j of jobs) {
    const p = j.projectNumber != null ? projectIdByNumber.get(Number(j.projectNumber)) : null;
    if (p) jobByProject.set(idStr(p), idStr(j._id));
  }
  return { jobIds, jobByContract, jobByProject };
}

const emptyEmployeeTotals = () => ({ days: 0, hours: 0, cost: 0, uncostedDays: 0, estimatedRateDays: 0, pendingDays: 0, pendingHours: 0, pendingCost: 0 });

/**
 * One job's labour table from its groups.
 *
 * @param {object[]} groups - groupsPipeline()/groupRecords() rows for this job only
 * @param {object} p
 * @param {Map<string, object>} p.employeesById - lean employees (name, hourlyRate)
 * @param {Map<string, object>} p.suppliersById - lean REST suppliers (Code, Name)
 * @param {object[]} p.purchases - purchasesForProject().purchases (lines on this job only)
 * @returns {{ people: object[], employees: object, subcontractors: object }}
 */
export function labourForJob(groups = [], { employeesById = new Map(), suppliersById = new Map(), purchases = [] } = {}) {
  const people = new Map();
  for (const g of groups) {
    const empId = idStr(g._id?.employee);
    const subId = idStr(g._id?.subcontractor);
    if (!empId && !subId) continue;
    const kind = empId ? 'employee' : 'subcontractor';
    const key = `${kind}:${empId || subId}`;
    const record = empId ? employeesById.get(empId) : suppliersById.get(subId);
    const p = people.get(key) || {
      kind, id: empId || subId,
      name: (empId ? record?.name : record?.Name) || (empId ? 'Unknown employee' : 'Unknown subcontractor'),
      supplierCode: subId ? (record?.Code ? String(record.Code).trim() : '') : null,
      noHourlyRate: false,
      ...emptyEmployeeTotals(),
    };
    const cost = empId ? groupCost(g, record) : 0;
    if (empId && g.hourlyHours > 0 && !(toNum(record?.hourlyRate) > 0)) p.noHourlyRate = true;
    if (g._id?.approved) {
      p.days += g.days || 0;
      p.hours += g.hours || 0;
      p.cost = roundPence(p.cost + cost);
      if (empId) p.uncostedDays += g.uncostedDays || 0;
      if (empId) p.estimatedRateDays += g.estimatedRateDays || 0;
    } else {
      p.pendingDays += g.days || 0;
      p.pendingHours += g.hours || 0;
      p.pendingCost = roundPence(p.pendingCost + cost);
    }
    people.set(key, p);
  }

  // Subcontractors: their purchase lines on this job
  const bySupplier = new Map();
  for (const pur of purchases) {
    const k = codeKey(pur.supplierCode);
    if (!k) continue;
    const s = bySupplier.get(k) || { labour: 0, materials: 0, invoices: 0 };
    s.labour = roundPence(s.labour + (Number(pur.labour) || 0));
    s.materials = roundPence(s.materials + (Number(pur.materials) || 0));
    s.invoices += 1;
    bySupplier.set(k, s);
  }
  for (const p of people.values()) {
    if (p.kind !== 'subcontractor') continue;
    const s = p.supplierCode ? bySupplier.get(codeKey(p.supplierCode)) : null;
    p.purchaseCost = s ? s.labour : 0;
    p.purchaseMaterials = s ? s.materials : 0;
    p.purchaseInvoices = s ? s.invoices : 0;
  }

  const list = [...people.values()].map((p) => ({ ...p, hours: round2(p.hours), pendingHours: round2(p.pendingHours) }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'employee' ? -1 : 1) || a.name.localeCompare(b.name));
  const sum = (xs, k) => xs.reduce((t, p) => t + (Number(p[k]) || 0), 0);
  const emps = list.filter((p) => p.kind === 'employee');
  const subs = list.filter((p) => p.kind === 'subcontractor');
  return {
    people: list,
    employees: {
      days: sum(emps, 'days'), hours: round2(sum(emps, 'hours')), cost: roundPence(sum(emps, 'cost')), uncostedDays: sum(emps, 'uncostedDays'),
      estimatedRateDays: sum(emps, 'estimatedRateDays'),
      pendingDays: sum(emps, 'pendingDays'), pendingHours: round2(sum(emps, 'pendingHours')), pendingCost: roundPence(sum(emps, 'pendingCost')),
      noHourlyRate: emps.some((p) => p.noHourlyRate),
    },
    subcontractors: {
      days: sum(subs, 'days'), hours: round2(sum(subs, 'hours')), pendingDays: sum(subs, 'pendingDays'),
      purchaseCost: roundPence(sum(subs, 'purchaseCost')),
    },
  };
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Employee labour per job, for the register: Map(job _id string → totals).
 * Subcontractor days are left out (their cost is in purchases).
 */
export function employeeLabourByJob(groups = [], index, employeesById = new Map()) {
  const out = new Map();
  for (const g of groups) {
    const empId = idStr(g._id?.employee);
    if (!empId) continue;
    const job = jobForGroup(g._id, index);
    if (!job) continue;
    const t = out.get(job) || emptyEmployeeTotals();
    const cost = groupCost(g, employeesById.get(empId));
    if (g._id.approved) {
      t.days += g.days || 0;
      t.hours = round2(t.hours + (g.hours || 0));
      t.cost = roundPence(t.cost + cost);
      t.uncostedDays += g.uncostedDays || 0;
      t.estimatedRateDays += g.estimatedRateDays || 0;
    } else {
      t.pendingDays += g.days || 0;
      t.pendingHours = round2(t.pendingHours + (g.hours || 0));
      t.pendingCost = roundPence(t.pendingCost + cost);
    }
    out.set(job, t);
  }
  return out;
}

/**
 * A job's margin: income − (materials + labour). Income is the invoiced
 * value, or the agreed (won) value while nothing is invoiced; basis says
 * which ('invoiced' | 'agreed'). percent is of income, null when income is 0.
 *
 * @param {{ invoiced: number, agreed: number }} values - jobValues()
 * @param {number} materials - purchase lines sorted as materials
 * @param {number} labour - approved employee labour + purchase lines sorted as labour
 */
export function jobMargin(values = {}, materials = 0, labour = 0) {
  const invoiced = Number(values.invoiced) || 0;
  const basis = invoiced > 0 ? 'invoiced' : 'agreed';
  const income = basis === 'invoiced' ? invoiced : (Number(values.agreed) || 0);
  const m = roundPence(Number(materials) || 0);
  const l = roundPence(Number(labour) || 0);
  const costs = roundPence(m + l);
  const margin = roundPence(income - costs);
  return {
    basis, income: roundPence(income), materials: m, labour: l, costs, margin,
    percent: income ? Math.round((margin / income) * 1000) / 10 : null,
  };
}

/**
 * The register's cost columns for its rows: per job (by uuid) its materials,
 * labour (employees + bought-in), costs and margin, or null for a job with no
 * project number; and totals over the live (not cancelled) jobs, overall and
 * per tax year.
 *
 * @param {object[]} rows - buildRegister() rows ({ entry, stage, values, taxYear })
 * @param {Map<number, {materials:number, labour:number}>} purchasesByNumber - purchaseCostsByProject()
 * @param {Map<string, object>} labourByJobId - employeeLabourByJob()
 */
export function registerCosts(rows = [], purchasesByNumber = new Map(), labourByJobId = new Map()) {
  const byUuid = {};
  const blank = () => ({ materials: 0, labour: 0, costs: 0, margin: 0, jobs: 0 });
  const totals = blank();
  const byYear = {};
  for (const r of rows) {
    const e = r.entry;
    if (e.projectNumber == null) { byUuid[e.uuid] = null; continue; }
    const bought = purchasesByNumber.get(Number(e.projectNumber)) || {};
    const lab = labourByJobId.get(idStr(e._id)) || emptyEmployeeTotals();
    const m = jobMargin(r.values, bought.materials || 0, lab.cost + (bought.labour || 0));
    byUuid[e.uuid] = {
      materials: m.materials, labour: m.labour, employeeLabour: lab.cost, boughtLabour: roundPence(bought.labour || 0),
      costs: m.costs, pendingLabour: lab.pendingCost, pendingDays: lab.pendingDays, margin: m.margin, basis: m.basis,
    };
    if (r.stage === 'cancelled') continue;
    const y = r.taxYear ?? 'none';
    byYear[y] = byYear[y] || blank();
    for (const t of [totals, byYear[y]]) {
      t.materials = roundPence(t.materials + m.materials);
      t.labour = roundPence(t.labour + m.labour);
      t.costs = roundPence(t.costs + m.costs);
      t.margin = roundPence(t.margin + m.margin);
      t.jobs += 1;
    }
  }
  return { byUuid, totals, byYear };
}

// ── Database ─────────────────────────────────────────────────────────────────

const byId = (docs) => new Map((docs || []).map((d) => [String(d._id), d]));

async function peopleFor(groups) {
  const empIds = [...new Set(groups.map((g) => idStr(g._id?.employee)).filter(Boolean))];
  const subIds = [...new Set(groups.map((g) => idStr(g._id?.subcontractor)).filter(Boolean))];
  const [employees, suppliers] = await Promise.all([
    empIds.length ? mdb.INTERNAL.employee.find({ _id: { $in: empIds } }).select('name hourlyRate definedRate').lean() : [],
    subIds.length && mdb.REST?.supplier ? mdb.REST.supplier.find({ _id: { $in: subIds } }).select('Code Name').lean() : [],
  ]);
  return { employeesById: byId(employees), suppliersById: byId(suppliers) };
}

/**
 * One job's costs for its page: purchases (lines on the job), labour, costs
 * (materials + labour), the margin and KashFlow's own project figures.
 *
 * @param {object} job - lean job with _id, projectNumber, contractId (populated or not)
 * @param {object} values - jobValues(job)
 * @param {*} [projectId] - the synced REST project's _id for the job's number
 */
export async function loadJobCosts(job, values, projectId = null) {
  const contractId = job.contractId?._id ?? job.contractId ?? null;
  const [purchases, figures, contractJobs] = await Promise.all([
    job.projectNumber != null ? jobCost.purchasesForProject(job.projectNumber) : { purchases: [], net: 0, materials: 0, labour: 0 },
    job.projectNumber != null ? jobCost.kashflowProjectFigures([job.projectNumber]) : new Map(),
    contractId ? mdb.INTERNAL.jobRegister.countDocuments({ contractId }) : 0,
  ]);
  const match = attendanceMatch({
    jobIds: [job._id],
    // A contract on more than one job: its older days can't be told apart
    contractIds: contractId && contractJobs <= 1 ? [contractId] : [],
    projectIds: projectId ? [projectId] : [],
  });
  const groups = await mdb.INTERNAL.attendance.aggregate(groupsPipeline(match));
  const people = await peopleFor(groups);
  const labour = labourForJob(groups, { ...people, purchases: purchases.purchases });
  const margin = jobMargin(values, purchases.materials || 0, labour.employees.cost + (purchases.labour || 0));
  return {
    purchases,
    labour,
    costs: {
      materials: margin.materials,
      labour: { employees: labour.employees.cost, bought: roundPence(purchases.labour || 0), total: margin.labour },
      total: margin.costs,
    },
    margin,
    kashflow: job.projectNumber != null ? figures.get(Number(job.projectNumber)) || null : null,
  };
}

/**
 * The register's cost columns for the rows on the page: one purchase
 * aggregate and one attendance aggregate for all of them.
 *
 * @param {object[]} rows - buildRegister() rows
 */
export async function loadRegisterCosts(rows = []) {
  const jobs = rows.map((r) => r.entry).filter((e) => e.projectNumber != null);
  if (!jobs.length) return registerCosts(rows);
  const numbers = jobs.map((e) => Number(e.projectNumber));
  const [purchasesByNumber, projects, allContracted] = await Promise.all([
    jobCost.purchaseCostsByProject(numbers),
    mdb.REST?.project ? mdb.REST.project.find({ Number: { $in: numbers } }).select('_id Number').lean() : [],
    // Every job with one of these contracts (not just those on the page), so a shared contract is spotted
    (() => {
      const ids = [...new Set(jobs.map((e) => idStr(e.contractId)).filter(Boolean))];
      return ids.length ? mdb.INTERNAL.jobRegister.find({ contractId: { $in: ids } }).select('_id contractId').lean() : [];
    })(),
  ]);
  const projectIdByNumber = new Map(projects.map((p) => [Number(p.Number), p._id]));
  const index = jobIndex(jobs, projectIdByNumber);
  const shared = jobIndex(allContracted).jobByContract;
  for (const c of [...index.jobByContract.keys()]) if (!shared.has(c)) index.jobByContract.delete(c);
  const groups = await mdb.INTERNAL.attendance.aggregate(groupsPipeline(attendanceMatch({
    jobIds: jobs.map((e) => e._id),
    contractIds: [...index.jobByContract.keys()].map((c) => new mongoose.Types.ObjectId(c)),
    projectIds: [...projectIdByNumber.values()],
  })));
  const empIds = [...new Set(groups.map((g) => idStr(g._id?.employee)).filter(Boolean))];
  const employees = empIds.length ? await mdb.INTERNAL.employee.find({ _id: { $in: empIds } }).select('name hourlyRate').lean() : [];
  return registerCosts(rows, purchasesByNumber, employeeLabourByJob(groups, index, byId(employees)));
}

export default {
  LABOUR_TYPES, attendanceMatch, groupsPipeline, groupRecords, groupCost, jobForGroup, jobIndex,
  labourForJob, employeeLabourByJob, jobMargin, registerCosts, loadJobCosts, loadRegisterCosts,
};
