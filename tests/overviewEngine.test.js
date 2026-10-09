import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import registry from '../mongoose/config/overviews/index.js';
import engine from '../mongoose/services/overviewEngine.js';

const admin = { user: { role: 'admin', customPermissions: {} }, query: {} };
const employeeUser = { user: { role: 'employee', customPermissions: {} }, query: {} };

let calls = [];
function mockModel(name, { count = 3, rows = [], groups = [], distinct = [] } = {}) {
  const q = (result) => {
    const chain = { sort: () => chain, limit: () => chain, select: () => chain, lean: () => Promise.resolve(result) };
    return chain;
  };
  return {
    find: (filter) => { calls.push({ name, op: 'find', filter }); return q(rows); },
    countDocuments: async (filter) => { calls.push({ name, op: 'count', filter }); return count; },
    aggregate: async (pipeline) => { calls.push({ name, op: 'aggregate', pipeline }); return groups; },
    distinct: async () => distinct,
  };
}

function patchModels() {
  calls = [];
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    employee: mockModel('employee', {
      count: 4,
      rows: [{ uuid: 'e-1', name: 'Jane Doe', position: 'Gardener', contract: { endDate: new Date('2026-09-01') } }],
      groups: [{ _id: 'full-time', count: 3 }, { _id: 'part-time', count: 1 }],
    }),
    attendance: mockModel('attendance', { count: 2 }),
    task: mockModel('task', { count: 5 }),
    holidayRequest: mockModel('holidayRequest', { count: 1 }),
    vehicle: mockModel('vehicle', { count: 2 }),
    assignment: mockModel('assignment', { distinct: [] }),
    user: mockModel('user'),
  };
}

describe('overview registry', () => {
  it('has no broken references', () => {
    assert.deepStrictEqual(registry.validate(), []);
  });

  it('resolves figure refs', () => {
    const f = registry.getFigure('employee.contractsEndingSoon');
    assert.equal(f.node.model, 'employee');
    assert.equal(registry.getFigure('employee.nope'), null);
    assert.equal(registry.getFigure('leave.pending'), null); // group nodes own no figures
  });
});

describe('compileWhere', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('resolves relative dates against now', () => {
    const w = engine.compileWhere({
      a: { $withinNextDays: 60 },
      b: { $withinPastDays: 30 },
      c: { $beforeNow: true },
      d: { $notAfterDays: 90 },
      e: { $set: true },
      f: 'x',
      g: { $ne: 'Disposed' },
    }, now);
    assert.deepStrictEqual(w.a, { $gte: now, $lte: new Date(now.getTime() + 60 * day) });
    assert.deepStrictEqual(w.b, { $gte: new Date(now.getTime() - 30 * day), $lte: now });
    assert.deepStrictEqual(w.c, { $ne: null, $lt: now });
    assert.deepStrictEqual(w.d, { $ne: null, $lte: new Date(now.getTime() + 90 * day) });
    assert.deepStrictEqual(w.e, { $ne: null });
    assert.equal(w.f, 'x');
    assert.deepStrictEqual(w.g, { $ne: 'Disposed' });
  });

  it("resolves $me to the viewer, and to nothing when there's no viewer", () => {
    assert.deepStrictEqual(engine.compileWhere({ userId: { $me: true } }, now, { userId: 'u-9' }).userId, { $eq: 'u-9' });
    assert.deepStrictEqual(engine.compileWhere({ userId: { $me: true } }, now).userId, { $in: [] });
  });
});

describe('breadcrumbs', () => {
  it('walks primary parents up to home', () => {
    const crumbs = engine.breadcrumbs(admin, 'holidayRequest');
    assert.deepStrictEqual(crumbs.map((c) => c.label), ['Home', 'Human Resources', 'Holiday', 'Holiday requests']);
    assert.equal(crumbs[1].href, '/overview/human');
    assert.equal(crumbs[2].href, '/overview/holiday');
  });

  it("doesn't link to pages the user can't open", () => {
    const crumbs = engine.breadcrumbs(employeeUser, 'employee');
    assert.equal(crumbs[1].label, 'Human Resources');
    assert.equal(crumbs[1].href, null);
  });
});

describe('resolveListView', () => {
  it('narrows a list to a figure of the same model', async () => {
    const r = await engine.resolveListView({ ...admin, query: { view: 'employee.contractsExpired', tab: 'active', page: '3' } }, 'employee');
    assert.equal(r.view.label, 'Fixed-term contracts ended');
    assert.equal(r.filter['contract.termsType'], 'fixed-term');
    assert.equal(r.view.clearHref, '/employees?tab=active');
    assert.deepStrictEqual(r.crumbs.map((c) => c.label), ['Home', 'Human Resources']);
  });

  it("ignores a view that belongs to another model, or doesn't exist", async () => {
    assert.equal((await engine.resolveListView({ ...admin, query: { view: 'task.overdue' } }, 'employee')).filter, null);
    assert.equal((await engine.resolveListView({ ...admin, query: { view: 'employee.made_up' } }, 'employee')).filter, null);
  });

  it('returns nothing for models outside the hierarchy', async () => {
    const r = await engine.resolveListView({ ...admin, query: {} }, 'currency');
    assert.deepStrictEqual(r, { filter: null, view: null, crumbs: null });
  });
});

describe('buildArea', () => {
  beforeEach(patchModels);

  it('shows each child with its summary figures, each linking one level down', async () => {
    const page = await engine.buildArea(admin, 'human');
    assert.deepStrictEqual(page.cards.map((c) => c.id), ['employee', 'leave', 'attendance', 'task']);
    const leave = page.cards.find((c) => c.id === 'leave');
    assert.equal(leave.href, '/overview/holiday'); // Holiday opens its overview, not a list
    assert.equal(leave.figures[0].href, '/holidayRequests?view=holidayRequest.pending');
    const emp = page.cards.find((c) => c.id === 'employee');
    assert.equal(emp.href, '/overview/employee');
    assert.equal(emp.linkLabel, 'Employees overview');
    assert.equal(emp.figures[0].value, 4);
    assert.equal(emp.figures[0].href, '/employees?view=employee.active');
  });

  it('hides everything the user may not open', async () => {
    const page = await engine.buildArea(employeeUser, 'human');
    for (const card of page.cards) {
      for (const f of card.figures) assert.ok(f.href, 'every shown figure is openable');
    }
    assert.ok(!page.cards.some((c) => c.id === 'employee' && c.href === '/overview/employee'));
  });
});

describe('buildNodeOverview', () => {
  beforeEach(patchModels);

  it('builds the employee overview', async () => {
    const page = await engine.buildNodeOverview(admin, 'employee');
    assert.equal(page.title, 'Employees');
    assert.ok(page.figures.length >= 5);
    const byHours = page.breakdowns.find((b) => b.label === 'By hours');
    assert.deepStrictEqual(byHours.segments.map((s) => s.label), ['Full-time', 'Part-time']);
    assert.equal(byHours.segments[0].href, '/employees?f_type=full-time'); // reuses the list's own filter
    const ended = page.lists.find((l) => l.title === 'Fixed-term contracts ended');
    assert.equal(ended.rows[0].href, '/employee/read/e-1');
    assert.equal(ended.rows[0].cells[2], '01/09/2026');
    assert.equal(ended.href, '/employees?view=employee.contractsExpired');
    assert.deepStrictEqual(page.related.map((f) => f.ref), ['holidayRequest.pending', 'attendance.pending', 'vehicle.withEmployee', 'task.employeeReminders']);
    assert.equal(page.related[1].group, 'Attendance'); // "Attendance · Awaiting approval", not a bare label
    assert.deepStrictEqual(page.crumbs.map((c) => c.label), ['Home', 'Human Resources']);
    assert.equal(page.listHref, '/employees');
  });

  it('returns null for nodes without a generated overview', async () => {
    assert.equal(await engine.buildNodeOverview(admin, 'leave'), null);
    assert.equal(await engine.buildNodeOverview(admin, 'holidayRequest'), null);
  });
});

describe('subcontractors (alias list + KashFlow join)', () => {
  const hmrc = { user: { role: 'hmrc', customPermissions: {} }, query: {} };

  beforeEach(() => {
    patchModels();
    mdb.REST = {
      ...mdb.REST,
      supplier: { ...mockModel('supplier', { count: 7, groups: [{ _id: 20, count: 5 }, { _id: 30, count: 2 }] }), distinct: async () => ['SUB1', 'SUB2'] },
      purchase: mockModel('purchase', { count: 2, rows: [{ uuid: 'p-1', Number: 101, SupplierName: 'Sample Sub', IssuedDate: new Date('2026-10-01'), GrossAmount: 1200 }] }),
    };
    // keep INTERNAL lookups from shadowing the REST models
    delete mdb.INTERNAL.supplier;
    delete mdb.INTERNAL.purchase;
  });

  it("counts only the alias list's rows (base filter applied)", async () => {
    const f = await engine.computeFigure(admin, 'subcontractor.active', new Date());
    assert.equal(f.value, 7);
    assert.equal(f.href, '/subcontractors?view=subcontractor.active');
    const count = calls.find((c) => c.name === 'supplier' && c.op === 'count');
    // the same rule as the /subcontractors list: cisService.cisSupplierQuery
    assert.ok(count.filter.$and[1].$or.some((c) => c.ApplyWithholdingTax === true));
    assert.ok(count.filter.$and[1].$or.some((c) => c.WithholdingTaxRate && c.WithholdingTaxRate.$gt === 0));
  });

  it('applies ?view= on the alias list', async () => {
    const r = await engine.resolveListView({ ...admin, query: { view: 'subcontractor.unverified' } }, 'subcontractor');
    assert.equal(r.view.label, 'Not verified with HMRC');
    assert.ok(Array.isArray(r.filter.$nor));
    assert.deepStrictEqual(r.crumbs.map((c) => c.label), ['Home', 'Subcontractors']);
    // the plain supplier list isn't the subcontractor node's list
    assert.equal((await engine.resolveListView({ ...admin, query: { view: 'subcontractor.unverified' } }, 'supplier')).filter, null);
  });

  it('builds the overview: rate tabs, purchases joined by supplier code, admin-only links hidden from HMRC', async () => {
    const page = await engine.buildNodeOverview(admin, 'subcontractor');
    const rates = page.breakdowns[0];
    assert.deepStrictEqual(rates.segments.map((s) => [s.label, s.href]), [['20%', '/subcontractors?tab=20'], ['30%', '/subcontractors?tab=30']]);
    const purchases = page.lists.find((l) => l.title.startsWith('Subcontractor purchases'));
    assert.equal(purchases.rows[0].href, '/purchase/read/p-1');
    assert.equal(purchases.rows[0].cells[3], '£1,200.00');
    const find = calls.find((c) => c.name === 'purchase' && c.op === 'find');
    assert.deepStrictEqual(find.filter.SupplierCode, { $in: ['SUB1', 'SUB2'] });
    assert.equal(page.actions[0].label, 'Edit CIS details');

    const hmrcPage = await engine.buildNodeOverview(hmrc, 'subcontractor');
    assert.deepStrictEqual(hmrcPage.related, []); // employee and user figures aren't theirs to see
    assert.deepStrictEqual(hmrcPage.actions, []); // /subcontractor/assign is admin-only
    assert.equal(hmrcPage.crumbs[1].href, '/overview/subcontractors');
  });
});

describe('fleet', () => {
  beforeEach(() => {
    patchModels();
    const sumModel = (name, total) => ({ ...mockModel(name, { count: 6 }), aggregate: async (pipeline) => {
      calls.push({ name, op: 'aggregate', pipeline });
      return pipeline[1].$group._id === null ? [{ _id: null, total }] : [];
    } });
    mdb.INTERNAL.vehicleFuelLog = sumModel('vehicleFuelLog', 412.5);
    mdb.INTERNAL.vehicleMileageLog = sumModel('vehicleMileageLog', 1234.4);
    mdb.INTERNAL.vehicleService = sumModel('vehicleService', 0);
  });

  it('shows totals as sum figures that still open the rows behind them', async () => {
    const spend = await engine.computeFigure(admin, 'vehicleFuelLog.spend30', new Date());
    assert.equal(spend.value, 412.5);
    assert.equal(spend.display, '£412.50');
    assert.equal(spend.href, '/vehicleFuelLogs?view=vehicleFuelLog.spend30');
    const miles = await engine.computeFigure(admin, 'vehicleMileageLog.miles30', new Date());
    assert.equal(miles.display, '1,234 mi');
  });

  it('builds the Fleet area from its four models', async () => {
    const page = await engine.buildArea(admin, 'fleet');
    assert.deepStrictEqual(page.cards.map((c) => c.id), ['vehicle', 'vehicleService', 'vehicleFuelLog', 'vehicleMileageLog']);
    assert.ok(page.cards.every((c) => c.href.startsWith('/overview/')));
  });

  it('expired compliance checks MOT, insurance and road tax on vehicles still in the fleet', async () => {
    await engine.computeFigure(admin, 'vehicle.complianceExpired', new Date());
    const count = calls.find((c) => c.name === 'vehicle' && c.op === 'count');
    assert.deepStrictEqual(count.filter.availabilityStatus, { $ne: 'Disposed' });
    assert.deepStrictEqual(count.filter.$or.map((c) => Object.keys(c)[0]), ['motExpiryDate', 'insuranceExpiryDate', 'roadTaxExpiryDate']);
  });
});

describe('projects', () => {
  beforeEach(() => {
    patchModels();
    mdb.INTERNAL.contract = mockModel('contract', { count: 2, rows: [{ uuid: 'c-1', title: 'Sample job', endDate: new Date('2026-09-30') }] });
    mdb.INTERNAL.assignment = { ...mockModel('assignment', { count: 1 }), distinct: async () => [] };
    mdb.REST = {
      ...mdb.REST,
      project: mockModel('project', { count: 3, rows: [
        { Number: 1, Name: 'Below', Status: 'Active', TargetSalesAmount: 1000, ActualSalesAmount: 400 },
        { Number: 2, Name: 'Met', Status: 'Active', TargetSalesAmount: 500, ActualSalesAmount: 600 },
        { Number: 3, Name: 'No income', Status: 'Active', TargetSalesAmount: 500, ActualSalesAmount: 0 },
      ] }),
    };
    delete mdb.INTERNAL.project;
  });

  it('builds the Projects area from contracts, assignments and KashFlow projects', async () => {
    const page = await engine.buildArea(admin, 'projects');
    assert.deepStrictEqual(page.cards.map((c) => c.id), ['contract', 'assignment', 'project']);
  });

  it('passes $expr through untouched for income-against-target figures', () => {
    const f = registry.getFigure('project.belowTarget');
    const w = engine.compileWhere(f.figure.where, new Date());
    assert.deepStrictEqual(w.$expr.$and[1], { $lt: ['$ActualSalesAmount', '$TargetSalesAmount'] });
    assert.deepStrictEqual(w.Status, { $nin: ['Completed', 'Archived'] });
  });

  it('keeps the financial check panel (with its actions) on the KashFlow projects overview', async () => {
    const page = await engine.buildNodeOverview(admin, 'project');
    assert.equal(page.partials.length, 1);
    const p = page.partials[0];
    assert.equal(p.partial, 'panels/projectFinancials');
    assert.deepStrictEqual(p.locals.restProjectsAtRisk.map((x) => x.Name), ['Below']);
    assert.deepStrictEqual(p.locals.restProjectsReadyToComplete.map((x) => x.Name), ['Met']);
    assert.deepStrictEqual(p.locals.restProjects.map((x) => x.Name), ['Below', 'Met']);
  });

  it('lists in-progress contracts nobody is assigned to', async () => {
    const page = await engine.buildNodeOverview(admin, 'contract');
    const panel = page.lists.find((l) => l.title === 'In progress with no current assignments');
    assert.equal(panel.rows[0].href, '/contract/read/c-1');
  });
});

describe('finance (and a node with two parents)', () => {
  beforeEach(() => {
    patchModels();
    const rest = {};
    for (const m of ['invoice', 'purchase', 'customer', 'supplier', 'quote']) {
      rest[m] = { ...mockModel(m, { count: 3 }), aggregate: async (p) => { calls.push({ name: m, op: 'aggregate', pipeline: p }); return p[1].$group._id === null ? [{ total: 1500.25 }] : []; }, distinct: async () => [] };
      delete mdb.INTERNAL[m];
    }
    mdb.REST = { ...mdb.REST, ...rest };
  });

  it('builds Finance with Subcontractors as a second-parent child that remembers the way in', async () => {
    const page = await engine.buildArea(admin, 'finance');
    assert.deepStrictEqual(page.cards.map((c) => c.id), ['invoice', 'purchase', 'customer', 'supplier', 'subcontractor', 'quote']);
    const sub = page.cards.find((c) => c.id === 'subcontractor');
    assert.equal(sub.href, '/overview/subcontractor?from=finance');
    assert.equal(sub.linkLabel, 'Subcontractors overview');
    assert.equal(page.cards.find((c) => c.id === 'invoice').href, '/overview/invoice'); // primary parent: no from
  });

  it('follows the way in for breadcrumbs, and the primary parent otherwise', async () => {
    const viaFinance = await engine.buildNodeOverview({ ...admin, query: { from: 'finance' } }, 'subcontractor');
    assert.deepStrictEqual(viaFinance.crumbs.map((c) => c.label), ['Home', 'Finance']);
    const direct = await engine.buildNodeOverview(admin, 'subcontractor');
    assert.deepStrictEqual(direct.crumbs.map((c) => c.label), ['Home', 'Subcontractors']);
  });

  it('sums what customers owe from unpaid, unarchived invoices', async () => {
    const f = await engine.computeFigure(admin, 'invoice.owed', new Date());
    assert.equal(f.display, '£1,500.25');
    const agg = calls.find((c) => c.name === 'invoice' && c.op === 'aggregate');
    assert.deepStrictEqual(agg.pipeline[0].$match.Status, { $nin: ['Paid', 'Credited', 'Cancelled'] });
    assert.deepStrictEqual(agg.pipeline[0].$match.IsArchived, { $ne: true });
    // DueAmount isn't synced, so owed = gross − paid
    assert.ok(agg.pipeline[1].$group.total.$sum.$subtract);
  });

  it('keeps accountants out of nothing they can open, and HMRC out of Finance', async () => {
    const accountant = { user: { role: 'accountant', customPermissions: {} }, query: {} };
    const a = await engine.buildArea(accountant, 'finance');
    assert.ok(a.cards.length >= 5);
    const hmrc = { user: { role: 'hmrc', customPermissions: {} }, query: {} };
    const h = await engine.buildArea(hmrc, 'finance');
    assert.ok(h.cards.every((c) => c.id === 'subcontractor' || c.id === 'supplier'));
  });
});

describe('home tiles', () => {
  const as = (role) => ({ user: { role, customPermissions: {} }, query: {} });

  it('lists the top-level areas in order, without Holiday', () => {
    const tiles = engine.homeTiles(admin).map((t) => t.href);
    assert.deepStrictEqual(tiles, [
      '/overview/human', '/overview/fleet', '/overview/finance', '/overview/projects', '/overview/subcontractors',
      '/overview/payroll', '/overview/documents', '/overview/policies', '/overview/admin',
    ]);
    assert.ok(!tiles.includes('/overview/holiday'));
  });

  it('only shows a role the areas it can open', () => {
    assert.deepStrictEqual(engine.homeTiles(as('accountant')).map((t) => t.label), ['Finance', 'Subcontractors', 'Payroll']);
    assert.deepStrictEqual(engine.homeTiles(as('hmrc')).map((t) => t.label), ['Subcontractors']);
    assert.deepStrictEqual(engine.homeTiles(as('employee')), []);
  });

  it("doesn't generate pages for areas that are still hand-built", async () => {
    assert.equal(await engine.buildArea(admin, 'payroll'), null);
  });
});
