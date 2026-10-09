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
    assert.deepStrictEqual(page.related.map((f) => f.ref), ['holidayRequest.pending', 'attendance.pending', 'vehicle.withEmployee']);
    assert.deepStrictEqual(page.crumbs.map((c) => c.label), ['Home', 'Human Resources']);
    assert.equal(page.listHref, '/employees');
  });

  it('returns null for nodes without a generated overview', async () => {
    assert.equal(await engine.buildNodeOverview(admin, 'leave'), null);
    assert.equal(await engine.buildNodeOverview(admin, 'holidayRequest'), null);
  });
});
