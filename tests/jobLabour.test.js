import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';

/*
 * jobLabourService reads mdb lazily inside its Database functions, so the
 * mdb singleton is patched with plain fakes — no database involved.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import {
  attendanceMatch, groupsPipeline, groupRecords, groupCost, grossPayFromRecords, jobForGroup, jobIndex,
  labourForJob, employeeLabourByJob, jobMargin, registerCosts, loadJobCosts, loadRegisterCosts,
} from '../mongoose/services/jobLabourService.js';
import { buildRegister, jobValues, matchJob, stageOf, jobTitle, STAGE_LABELS, STAGES, QUOTE_STATUSES, QUOTE_STATUS_LABELS } from '../mongoose/services/jobRegisterService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const oid = () => new mongoose.Types.ObjectId();
const d = (s) => new Date(`${s}T12:00:00Z`);
const D = (n) => mongoose.Types.Decimal128.fromString(String(n));

// Made-up people and jobs
const ann = { _id: oid(), name: 'Ann Example', hourlyRate: D(15) };
const bob = { _id: oid(), name: 'Bob Sample', hourlyRate: D(0) };
const subA = { _id: oid(), Code: 'SUBA01', Name: 'Sub A Ltd' };
const subB = { _id: oid(), Code: 'SUBB01', Name: 'Sub B Ltd' };
const JOB = oid();
const CONTRACT = oid();
const PROJECT = oid();

const rec = (over) => ({ type: 'work', status: 'approved', date: d('2026-10-01'), jobRegisterId: JOB, ...over });

describe('jobLabourService', () => {
  describe('payroll rule', () => {
    it('costs a day at its day rate, else hours × the hourly rate, the same as payroll', () => {
      const records = [
        rec({ employeeId: ann._id, dayRate: D(180) }),
        rec({ employeeId: ann._id, hoursWorked: D(7.5) }),
        rec({ employeeId: ann._id, hoursWorked: D(8), dayRate: D(0) }),
      ];
      const [g] = groupRecords(records);
      assert.equal(g.days, 3);
      assert.equal(g.hours, 15.5);
      assert.equal(g.dayRateTotal, 180);
      assert.equal(g.hourlyHours, 15.5);
      assert.equal(groupCost(g, ann), 180 + 15.5 * 15);
      assert.equal(groupCost(g, ann), grossPayFromRecords(records, ann));
    });

    it('counts a day with neither hours nor a day rate as uncosted', () => {
      const [g] = groupRecords([rec({ employeeId: ann._id }), rec({ employeeId: ann._id, hoursWorked: D(4) })]);
      assert.equal(g.uncostedDays, 1);
      assert.equal(groupCost(g, ann), 60);
    });

    it('builds an aggregate that groups by job link, person and approval', () => {
      const pipe = groupsPipeline({ x: 1 });
      assert.deepEqual(pipe[0], { $match: { x: 1 } });
      assert.deepEqual(Object.keys(pipe[1].$group._id), ['job', 'contract', 'project', 'employee', 'subcontractor', 'approved']);
      for (const k of ['days', 'hours', 'dayRateTotal', 'hourlyHours', 'uncostedDays']) assert.ok(pipe[1].$group[k], k);
    });
  });

  describe('which days belong to a job', () => {
    it('matches by job, and older days with no job by contract or project; work and training only, not rejected', () => {
      const m = attendanceMatch({ jobIds: [JOB], contractIds: [CONTRACT], projectIds: [PROJECT] });
      assert.deepEqual(m.type, { $in: ['work', 'training'] });
      assert.deepEqual(m.status, { $ne: 'rejected' });
      assert.deepEqual(m.$or, [
        { jobRegisterId: { $in: [JOB] } },
        { jobRegisterId: { $in: [null] }, contractId: { $in: [CONTRACT] } },
        { jobRegisterId: { $in: [null] }, projectId: { $in: [PROJECT] } },
      ]);
      assert.equal(attendanceMatch({ jobIds: [JOB] }).$or.length, 1);
    });

    it('puts a group on its job, else its contract (when only one job has it), else its project', () => {
      const other = oid();
      const shared = oid();
      const jobs = [
        { _id: JOB, projectNumber: 41300, contractId: CONTRACT },
        { _id: other, projectNumber: 41301, contractId: shared },
        { _id: oid(), projectNumber: 41302, contractId: shared },
      ];
      const index = jobIndex(jobs, new Map([[41300, PROJECT]]));
      assert.equal(jobForGroup({ job: JOB }, index), String(JOB));
      assert.equal(jobForGroup({ job: oid(), contract: CONTRACT }, index), null, 'a job not on the page');
      assert.equal(jobForGroup({ job: null, contract: CONTRACT }, index), String(JOB));
      assert.equal(jobForGroup({ job: null, contract: shared }, index), null, 'shared contract');
      assert.equal(jobForGroup({ job: null, contract: oid(), project: PROJECT }, index), String(JOB));
      assert.equal(jobForGroup({ job: null }, index), null);
    });
  });

  describe('labourForJob', () => {
    const purchases = [
      { number: 9001, supplierCode: 'suba01 ', net: 400 },
      { number: 9002, supplierCode: 'SUBA01', net: 250.5 },
      { number: 9003, supplierCode: 'MERCH', net: 99 },
    ];
    const records = [
      rec({ employeeId: ann._id, dayRate: D(180) }),
      rec({ employeeId: ann._id, hoursWorked: D(8) }),
      rec({ employeeId: ann._id, hoursWorked: D(6), status: 'pending' }),
      rec({ employeeId: ann._id, dayRate: D(180), status: 'site-approved' }),
      rec({ employeeId: bob._id, hoursWorked: D(5) }),
      rec({ subcontractorId: subA._id }),
      rec({ subcontractorId: subA._id, jobRegisterId: null, contractId: CONTRACT }),
      rec({ subcontractorId: subA._id, status: 'pending' }),
      rec({ subcontractorId: subB._id, hoursWorked: D(3) }), // legacy hours
    ];
    const labour = labourForJob(groupRecords(records), {
      employeesById: new Map([[String(ann._id), ann], [String(bob._id), bob]]),
      suppliersById: new Map([[String(subA._id), subA], [String(subB._id), subB]]),
      purchases,
    });
    const person = (name) => labour.people.find((p) => p.name === name);

    it('costs employees on approved days and keeps pending days apart as an estimate', () => {
      const a = person('Ann Example');
      assert.equal(a.kind, 'employee');
      assert.equal(a.days, 2);
      assert.equal(a.hours, 8);
      assert.equal(a.cost, 180 + 8 * 15);
      assert.equal(a.pendingDays, 2);
      assert.equal(a.pendingHours, 6);
      assert.equal(a.pendingCost, 6 * 15 + 180);
    });

    it('flags an employee paid by the hour with no hourly rate', () => {
      const b = person('Bob Sample');
      assert.equal(b.cost, 0);
      assert.equal(b.noHourlyRate, true);
      assert.equal(labour.employees.noHourlyRate, true);
    });

    it('gives subcontractors their days and their purchase lines on the job, matched by supplier code', () => {
      const a = person('Sub A Ltd');
      assert.equal(a.kind, 'subcontractor');
      assert.equal(a.days, 2);
      assert.equal(a.pendingDays, 1);
      assert.equal(a.cost, 0, 'not costed as labour');
      assert.equal(a.purchaseCost, 650.5);
      assert.equal(a.purchaseInvoices, 2);
      const b = person('Sub B Ltd');
      assert.equal(b.hours, 3);
      assert.equal(b.purchaseCost, 0);
    });

    it('totals employees (approved and pending) and subcontractors separately', () => {
      assert.deepEqual(
        { days: labour.employees.days, cost: labour.employees.cost, pendingDays: labour.employees.pendingDays, pendingCost: labour.employees.pendingCost },
        { days: 3, cost: 300, pendingDays: 2, pendingCost: 270 },
      );
      assert.equal(labour.subcontractors.days, 3);
      assert.equal(labour.subcontractors.pendingDays, 1);
      assert.equal(labour.subcontractors.purchaseCost, 650.5);
      assert.deepEqual(labour.people.map((p) => p.kind), ['employee', 'employee', 'subcontractor', 'subcontractor']);
    });
  });

  describe('jobMargin', () => {
    it('is invoiced − purchases − labour once anything is invoiced', () => {
      assert.deepEqual(jobMargin({ invoiced: 1000, agreed: 5000 }, 300, 200), { basis: 'invoiced', income: 1000, costs: 500, margin: 500, percent: 50 });
    });
    it('uses the agreed value while nothing is invoiced', () => {
      const m = jobMargin({ invoiced: 0, agreed: 2000 }, 2100.4, 0);
      assert.equal(m.basis, 'agreed');
      assert.equal(m.margin, -100.4);
      assert.equal(m.percent, -5);
    });
    it('has no percentage with no income', () => {
      assert.equal(jobMargin({}, 10, 0).percent, null);
      assert.equal(jobMargin({}, 10, 0).margin, -10);
    });
  });

  describe('registerCosts', () => {
    it('gives each job its costs, labour and margin, and totals live jobs per tax year and overall', () => {
      const j1 = { _id: oid(), uuid: 'j1', projectNumber: 41300 };
      const j2 = { _id: oid(), uuid: 'j2', projectNumber: 41301 };
      const j3 = { _id: oid(), uuid: 'j3', projectNumber: 41302 };
      const enquiry = { _id: oid(), uuid: 'q' };
      const rows = [
        { entry: j1, stage: 'invoiced', taxYear: 2026, values: { invoiced: 1000, agreed: 1000 } },
        { entry: j2, stage: 'won', taxYear: 2025, values: { invoiced: 0, agreed: 800 } },
        { entry: j3, stage: 'cancelled', taxYear: 2026, values: { invoiced: 0, agreed: 0 } },
        { entry: enquiry, stage: 'quoted', taxYear: 2026, values: { invoiced: 0, agreed: 0 } },
      ];
      const purchases = new Map([[41300, { net: 300 }], [41301, { net: 100 }], [41302, { net: 50 }]]);
      const labour = new Map([[String(j1._id), { cost: 200, pendingCost: 90, pendingDays: 1 }]]);
      const c = registerCosts(rows, purchases, labour);
      assert.deepEqual(c.byUuid.j1, { purchases: 300, labour: 200, pendingLabour: 90, pendingDays: 1, margin: 500, basis: 'invoiced' });
      assert.equal(c.byUuid.j2.margin, 700);
      assert.equal(c.byUuid.j2.basis, 'agreed');
      assert.equal(c.byUuid.j3.margin, -50);
      assert.equal(c.byUuid.q, null);
      assert.deepEqual(c.totals, { purchases: 400, labour: 200, margin: 1200, jobs: 2 });
      assert.deepEqual(c.byYear[2026], { purchases: 300, labour: 200, margin: 500, jobs: 1 });
      assert.deepEqual(c.byYear[2025], { purchases: 100, labour: 0, margin: 700, jobs: 1 });
    });

    it('employee labour per job leaves subcontractors out', () => {
      const index = jobIndex([{ _id: JOB, projectNumber: 41300, contractId: CONTRACT }], new Map());
      const groups = groupRecords([
        rec({ employeeId: ann._id, hoursWorked: D(8) }),
        rec({ employeeId: ann._id, jobRegisterId: null, contractId: CONTRACT, dayRate: D(150) }),
        rec({ employeeId: ann._id, hoursWorked: D(2), status: 'pending' }),
        rec({ subcontractorId: subA._id }),
      ]);
      const t = employeeLabourByJob(groups, index, new Map([[String(ann._id), ann]])).get(String(JOB));
      assert.equal(t.days, 2);
      assert.equal(t.cost, 120 + 150);
      assert.equal(t.pendingDays, 1);
      assert.equal(t.pendingCost, 30);
    });
  });

  describe('Database', () => {
    let saved;
    beforeEach(() => { saved = { REST: mdb.REST, INTERNAL: mdb.INTERNAL }; });
    afterEach(() => { mdb.REST = saved.REST; mdb.INTERNAL = saved.INTERNAL; });
    const q = (results) => {
      const o = { select: mock.fn(() => o), lean: mock.fn(() => Promise.resolve(results)) };
      return o;
    };

    it("loadJobCosts loads the job's purchases, labour, margin and KashFlow figures", async () => {
      const groups = groupRecords([
        rec({ employeeId: ann._id, dayRate: D(200) }),
        rec({ subcontractorId: subA._id }),
      ]);
      const aggregate = mock.fn(async () => groups);
      mdb.REST = {
        purchase: { find: mock.fn(() => q([{ Number: 9001, SupplierCode: 'SUBA01', SupplierName: 'Sub A Ltd', ProjectNumber: 41300, LineItems: [{ Quantity: 1, Rate: 400, Description: 'Labour' }] }])) },
        project: { find: mock.fn(() => q([{ Number: 41300, ActualPurchasesAmount: 410, ActualSalesAmount: 1000 }])) },
        supplier: { find: mock.fn(() => q([subA])) },
      };
      mdb.INTERNAL = {
        attendance: { aggregate },
        employee: { find: mock.fn(() => q([ann])) },
        jobRegister: { countDocuments: mock.fn(async () => 2) },
      };
      const job = { _id: JOB, projectNumber: 41300, contractId: { _id: CONTRACT, title: 'X' } };
      const costs = await loadJobCosts(job, { invoiced: 1000, agreed: 1000 }, PROJECT);
      assert.equal(costs.purchases.net, 400);
      assert.equal(costs.labour.employees.cost, 200);
      assert.equal(costs.labour.subcontractors.purchaseCost, 400);
      assert.deepEqual(costs.margin, { basis: 'invoiced', income: 1000, costs: 600, margin: 400, percent: 40 });
      assert.deepEqual(costs.kashflow, { actualPurchases: 410, actualSales: 1000 });
      const match = aggregate.mock.calls[0].arguments[0][0].$match;
      assert.equal(match.$or.length, 2, 'contract shared with another job is left out');
      assert.deepEqual(match.$or[1], { jobRegisterId: { $in: [null] }, projectId: { $in: [PROJECT] } });
    });

    it('loadRegisterCosts runs one purchase aggregate and one attendance aggregate for the page', async () => {
      const j1 = { _id: JOB, uuid: 'j1', projectNumber: 41300, contractId: CONTRACT };
      const enquiry = { _id: oid(), uuid: 'q' };
      const purchaseAgg = mock.fn(async () => [{ _id: 41300, net: 250, purchases: 1, lines: 1 }]);
      const attendanceAgg = mock.fn(async () => groupRecords([rec({ employeeId: ann._id, jobRegisterId: null, contractId: CONTRACT, hoursWorked: D(10) })]));
      mdb.REST = { purchase: { aggregate: purchaseAgg }, project: { find: mock.fn(() => q([{ _id: PROJECT, Number: 41300 }])) } };
      mdb.INTERNAL = {
        attendance: { aggregate: attendanceAgg },
        employee: { find: mock.fn(() => q([ann])) },
        jobRegister: { find: mock.fn(() => q([{ _id: JOB, contractId: CONTRACT }])) },
      };
      const rows = [
        { entry: j1, stage: 'won', taxYear: 2026, values: { invoiced: 0, agreed: 1000 } },
        { entry: enquiry, stage: 'quoted', taxYear: 2026, values: { invoiced: 0, agreed: 0 } },
      ];
      const c = await loadRegisterCosts(rows);
      assert.equal(purchaseAgg.mock.callCount(), 1);
      assert.equal(attendanceAgg.mock.callCount(), 1);
      assert.deepEqual(c.byUuid.j1, { purchases: 250, labour: 150, pendingLabour: 0, pendingDays: 0, margin: 600, basis: 'agreed' });
      assert.equal(c.byUuid.q, null);
      const match = attendanceAgg.mock.calls[0].arguments[0][0].$match;
      assert.ok(match.$or[1].contractId.$in[0] instanceof mongoose.Types.ObjectId, 'ObjectIds, as aggregate does not cast');
    });

    it('loadRegisterCosts needs no database when no job has a project number', async () => {
      mdb.REST = {};
      mdb.INTERNAL = {};
      const c = await loadRegisterCosts([{ entry: { uuid: 'q' }, stage: 'quoted', taxYear: 2026, values: {} }]);
      assert.equal(c.byUuid.q, null);
      assert.equal(c.totals.jobs, 0);
    });
  });
});

// ── Pages ───────────────────────────────────────────────────────────────

const job = {
  _id: JOB, uuid: 'f', projectNumber: 41300, jobDate: d('2026-10-01'), site: '9 Variation Row', client: 'Rigby Test',
  quotes: [{ _id: oid(), number: 51800, value: 1000, status: 'won' }], invoices: [],
};
const pageCosts = () => {
  const purchases = { purchases: [
    { number: 9001, date: d('2026-10-05'), supplierCode: 'SUBA01', supplierName: 'Sub A Ltd', lines: [{ description: 'Groundworks labour', net: 400, nominal: 5000 }], net: 400 },
    { number: 9002, date: d('2026-10-03'), supplierCode: 'MERCH', supplierName: 'Builders Merchant', lines: [{ description: 'Gravel', net: 120, nominal: 5000 }], net: 120 },
  ], net: 520 };
  const labour = labourForJob(groupRecords([
    rec({ employeeId: ann._id, dayRate: D(180) }),
    rec({ employeeId: ann._id, hoursWorked: D(4), status: 'pending' }),
    rec({ subcontractorId: subA._id }),
    rec({ subcontractorId: subA._id }),
  ]), {
    employeesById: new Map([[String(ann._id), ann]]),
    suppliersById: new Map([[String(subA._id), subA]]),
    purchases: purchases.purchases,
  });
  return { purchases, labour, margin: jobMargin(jobValues(job), purchases.net, labour.employees.cost), kashflow: { actualPurchases: 520, actualSales: null } };
};

describe('Job page costs', () => {
  const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/show.ejs');
  const render = (over = {}) => ejs.renderFile(view, {
    csrfToken: 'c', crumbs: [], title: jobTitle(job), job, stage: stageOf(job), values: jobValues(job),
    match: matchJob(job, {}), next: {}, stageLabels: STAGE_LABELS, quoteStatuses: QUOTE_STATUSES, quoteStatusLabels: QUOTE_STATUS_LABELS,
    canEdit: false, canCreate: { project: false, quotes: {} }, editQuote: null, editInvoice: null, ...over,
  });

  it('shows the cost tiles, the purchase invoices and the labour', async () => {
    const html = await render({ costs: pageCosts() });
    assert.match(html, /Costs \(purchases\)[\s\S]*£520\.00/);
    assert.match(html, /KashFlow's project figure: £520\.00/);
    assert.match(html, /Labour \(employees\)[\s\S]*£180\.00/);
    assert.match(html, /Not approved yet: 1 day, about £60\.00 \(not counted\)/);
    assert.match(html, />Margin<[\s\S]*£300\.00/);
    assert.match(html, /Agreed value \(nothing invoiced yet\) − purchases − employee labour/);
    assert.match(html, /id="purchases"/);
    for (const col of ['No', 'Date', 'Supplier', 'Lines on this job', 'Net', 'Person', 'Type', 'Days', 'Hours', 'Cost']) {
      assert.match(html, new RegExp(`>${col}</th>`), col);
    }
    assert.match(html, /9001[\s\S]*Sub A Ltd[\s\S]*Groundworks labour/);
    assert.match(html, /id="labour"/);
    assert.match(html, /Ann Example[\s\S]*Employee[\s\S]*about £60\.00 pending/);
    assert.match(html, /Sub A Ltd[\s\S]*Subcontractor[\s\S]*£400\.00 over 2 days/);
    assert.match(html, /Subcontractors \(cost is in purchases\)/);
    assert.match(html, /Employees, not approved yet \(estimate, not in the margin\)/);
    assert.doesNotMatch(html, /<script|onclick=/);
  });

  it('says when margin is on invoiced, and renders without costs', async () => {
    const invoicedJob = { ...job, invoices: [{ _id: oid(), number: 1700, value: 900 }] };
    const costs = { ...pageCosts(), margin: jobMargin(jobValues(invoicedJob), 520, 180) };
    const html = await render({ job: invoicedJob, values: jobValues(invoicedJob), match: matchJob(invoicedJob, {}), costs });
    assert.match(html, /Invoiced − purchases − employee labour/);
    assert.match(html, /£200\.00/);
    const none = await render();
    assert.doesNotMatch(none, /id="labour"|Costs \(purchases\)/);
  });

  it('shows the empty states', async () => {
    const empty = { purchases: { purchases: [], net: 0 }, labour: labourForJob([]), margin: jobMargin(jobValues(job), 0, 0), kashflow: null };
    const html = await render({ costs: empty });
    assert.match(html, /No purchase invoices on this job in KashFlow/);
    assert.match(html, /No attendance on this job yet/);
  });
});

describe('Job Register cost columns', () => {
  const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/index.ejs');
  const entries = [
    { ...job, uuid: 'f', invoices: [{ _id: oid(), number: 1700, value: 900 }] },
    { _id: oid(), uuid: 'g', projectNumber: 41250, jobDate: d('2025-06-01'), site: '1 Old Job', client: 'Plus Example', value: 500, quotes: [] },
    { _id: oid(), uuid: 'h', site: '2 Enquiry Rd', client: 'Plus Example', quotes: [{ _id: oid(), number: 51900, date: d('2026-11-01'), value: 300, status: 'quoted' }] },
  ];
  const register = buildRegister({ entries, quotesByNumber: new Map(), projectsByNumber: new Map(), invoicesByNumber: new Map(), filters: {} });
  const costs = registerCosts(register.rows, new Map([[41300, { net: 520 }], [41250, { net: 650 }]]), new Map([[String(JOB), { cost: 180, pendingCost: 60, pendingDays: 1 }]]));
  const base = {
    title: 'Job Register', csrfToken: 'c', crumbs: [], contracts: [], stageLabels: STAGE_LABELS, stages: STAGES, form: {},
    next: {}, unregistered: { year: 2026, quoteCount: 0, projectCount: 0, quotes: [], projects: [] },
  };

  it('adds Costs, Labour and Margin per job, per tax year and overall', async () => {
    const html = await ejs.renderFile(view, { ...base, ...register, costs });
    for (const col of ['Costs', 'Labour', 'Margin']) assert.match(html, new RegExp(`>${col}</th>`), col);
    assert.match(html, /£520\.00[\s\S]*£180\.00[\s\S]*\+1 day pending[\s\S]*£200\.00/);
    assert.match(html, /£650\.00[\s\S]*£0\.00[\s\S]*-£150\.00[\s\S]*on agreed/);
    assert.match(html, /<td class="[^"]*text-gray-400">—<\/td>/, 'enquiry has no project number');
    assert.match(html, /£520\.00 costs · £180\.00 labour ·\s*<span[^>]*>£200\.00 margin/);
    assert.match(html, /£650\.00 costs · £0\.00 labour ·\s*<span[^>]*>-£150\.00 margin/);
    assert.match(html, /Costs \(purchases\)<\/p>\s*<p[^>]*>£1,170\.00/);
    assert.match(html, />Margin<\/p>\s*<p[^>]*>£50\.00/);
  });

  it('leaves the columns out without costs', async () => {
    const html = await ejs.renderFile(view, { ...base, ...register });
    assert.doesNotMatch(html, />Margin<\/th>/);
  });
});
