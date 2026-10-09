import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import registry from '../mongoose/config/overviews/index.js';
import engine from '../mongoose/services/overviewEngine.js';
import svc from '../mongoose/services/overviewConfigService.js';
import employeeDef from '../mongoose/models/mongoose/INTERNAL/employee.js';
import taskDef from '../mongoose/models/mongoose/INTERNAL/task.js';

// Real schemas (field checks need them), fake query methods.
const model = (def) => ({ modelName: def.modelName, schema: def.schema, find: () => ({}) });
const admin = { user: { role: 'admin', customPermissions: {} }, query: {} };
const as = (role) => ({ user: { role, customPermissions: {} }, query: {} });

let stored = [];
function patch() {
  stored = [];
  const Store = function Store(data) {
    Object.assign(this, data);
    this.markModified = () => {};
    this.save = async () => { stored = stored.filter((d) => !(d.kind === this.kind && d.key === this.key)).concat([{ ...this }]); };
    this.deleteOne = async () => { stored = stored.filter((d) => !(d.kind === this.kind && d.key === this.key)); };
  };
  Store.find = () => ({ lean: async () => stored.map((d) => ({ ...d })) });
  Store.findOne = async (q) => { const d = stored.find((x) => x.kind === q.kind && x.key === q.key); return d ? new Store(d) : null; };
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    overviewConfig: Store,
    employee: model(employeeDef),
    task: model(taskDef),
  };
}

const ok = (change) => svc.validateOverride(change, [], { customPanels: engine.customPanelNames() });
const refused = (change, pattern) => assert.throws(() => ok(change), (err) => err instanceof svc.OverrideError && pattern.test(err.message));

describe('merging overrides onto the defaults', () => {
  afterEach(() => registry.applyOverrides([]));

  it('relabels, removes a figure, hides and reorders areas', () => {
    registry.applyOverrides([
      { kind: 'node', key: 'employee', override: { figures: { active: { label: 'People at work' }, inactive: null }, overview: { figures: ['active'] } } },
      { kind: 'area', key: 'fleet', override: { hidden: true } },
      { kind: 'area', key: 'finance', override: { order: 0 } },
    ]);
    const emp = registry.getNode('employee');
    assert.equal(emp.figures.active.label, 'People at work');
    assert.deepStrictEqual(emp.figures.active.where, { status: 'active' }); // untouched default filter
    assert.equal(emp.figures.inactive, undefined);
    assert.equal(registry.listAreas()[0].id, 'finance');
    assert.ok(!registry.listAreas().some((a) => a.id === 'fleet'));
    assert.ok(registry.listAllAreas().some((a) => a.id === 'fleet' && a.hidden));
  });

  it('a stored filter replaces the default filter whole, never merging into it', () => {
    registry.applyOverrides([{ kind: 'node', key: 'task', override: { figures: { overdue: { where: { completed: false } } } } }]);
    assert.deepStrictEqual(registry.getNode('task').figures.overdue.where, { completed: false });
  });

  it('reset is just removing the override', () => {
    registry.applyOverrides([{ kind: 'node', key: 'employee', override: { label: { one: 'Person', many: 'People' } } }]);
    assert.equal(registry.getNode('employee').label.many, 'People');
    registry.applyOverrides([]);
    assert.equal(registry.getNode('employee').label.many, 'Employees');
  });
});

describe('validating a stored change', () => {
  beforeEach(patch);

  it('accepts relabelling, hiding, and a new figure with a safe filter', () => {
    ok({ kind: 'node', key: 'employee', override: { label: { one: 'Person', many: 'People' }, hidden: false } });
    ok({ kind: 'node', key: 'employee', override: {
      figures: { partTime: { label: 'Part-time', where: { status: 'active', type: 'part-time', hireDate: { $withinPastDays: 365 } } } },
      overview: { figures: ['active', 'partTime'] },
    } });
    ok({ kind: 'area', key: 'human', override: { label: 'People', order: 2, children: ['employee', 'task'] } });
  });

  it('refuses anything that could run code or scan text', () => {
    refused({ kind: 'node', key: 'employee', override: { figures: { x: { label: 'X', where: { $where: 'sleep(1000)' } } } } }, /isn't allowed/);
    refused({ kind: 'node', key: 'employee', override: { figures: { x: { label: 'X', where: { name: { $regex: '(a+)+$' } } } } } }, /isn't allowed/);
    refused({ kind: 'node', key: 'employee', override: { figures: { x: { label: 'X', where: { $expr: { $gt: ['$a', '$b'] } } } } } }, /isn't allowed/);
    refused({ kind: 'node', key: 'employee', override: { figures: { x: { label: 'X', where: { name: { $function: {} } } } } } }, /isn't allowed/);
    refused({ kind: 'node', key: 'employee', override: { figures: { x: { label: 'X', sum: { $add: ['$a', 1] }, where: {} } } } }, /total must be a field/);
  });

  it('refuses fields the model does not have, and settings that only code may set', () => {
    refused({ kind: 'node', key: 'employee', override: { figures: { x: { label: 'X', where: { password: 'x' } } } } }, /isn't a field of employee/);
    refused({ kind: 'node', key: 'employee', override: { listRoute: '/x' } }, /can't be changed here/);
    refused({ kind: 'node', key: 'employee', override: { model: 'user' } }, /can't be changed here/);
    refused({ kind: 'node', key: 'employee', override: { overview: { panels: ['unassignedEmployees', 'activeSessions'] } } }, /removed or reordered here, not added/);
    refused({ kind: 'node', key: 'employee', override: { actions: [{ label: 'Go', href: 'https://example.com' }] } }, /path in this app/);
  });

  it('refuses changes that would break the hierarchy', () => {
    refused({ kind: 'node', key: 'employee', override: { figures: { active: null } } }, /unknown figure 'active'/);
    refused({ kind: 'area', key: 'human', override: { children: ['employee', 'invoice'] } }, /doesn't list it as a parent/);
    refused({ kind: 'node', key: 'employee', override: { figures: { brandNew: { label: 'No filter' } } } }, /needs a label and a filter/);
  });

  it('lets a new area and overview be created, opened only by the roles given', () => {
    const panels = { customPanels: engine.customPanelNames() };
    // Created in the order the editor does it: the area, then its node, then the link
    let docs = ok({ kind: 'area', key: 'operations', custom: true, override: { label: 'Operations', icon: 'bi-gear', roles: ['admin', 'accountant'] } });
    refused({ kind: 'area', key: 'ops2', custom: true, override: { label: 'No roles' } }, /needs the roles/);
    refused({ kind: 'area', key: 'ops3', custom: true, override: { label: 'Too soon', roles: ['admin'], children: ['nothingYet'] } }, /unknown child/);
    docs = svc.validateOverride({ kind: 'node', key: 'opsTasks', custom: true, override: {
      model: 'task', label: { one: 'Ops task', many: 'Ops tasks' }, parents: ['operations'],
      listPath: '/tasks', overviewPath: '/overview/opsTasks', roles: ['admin', 'accountant'],
      figures: { open: { label: 'Open', where: { completed: false } } }, summary: ['open'],
      overview: { figures: ['open'] },
    } }, docs, panels);
    docs = svc.validateOverride({ kind: 'area', key: 'operations', override: { label: 'Operations', icon: 'bi-gear', roles: ['admin', 'accountant'], children: ['opsTasks'] } }, docs, panels);
    registry.applyOverrides(docs);
    try {
      assert.equal(registry.getAreaByPath('/overview/operations').label, 'Operations');
      assert.equal(engine.canOpenPath(as('accountant'), '/overview/operations'), true);
      assert.equal(engine.canOpenPath(as('employee'), '/overview/operations'), false);
      assert.equal(engine.canOpenPath(as('accountant'), '/overview/opsTasks'), true);
      // Built-in pages keep their code rule: a stored change can't widen them
      assert.equal(engine.canOpenPath(as('accountant'), '/overview/human'), false);
    } finally {
      registry.applyOverrides([]);
    }
  });
});

describe('the store', () => {
  beforeEach(patch);
  afterEach(() => registry.applyOverrides([]));

  it('saves, applies straight away, and resets', async () => {
    await svc.load();
    await svc.save({ kind: 'node', key: 'employee', override: { label: { one: 'Person', many: 'People' } } }, { _id: 'admin-1' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].updatedBy, 'admin-1');
    assert.equal(registry.getNode('employee').label.many, 'People');
    await svc.reset({ kind: 'node', key: 'employee' });
    assert.equal(stored.length, 0);
    assert.equal(registry.getNode('employee').label.many, 'Employees');
  });

  it('skips a stored change that no longer fits instead of failing', async () => {
    stored = [
      { kind: 'node', key: 'employee', custom: false, override: { figures: { x: { label: 'X', where: { goneField: 1 } } } } },
      { kind: 'area', key: 'fleet', custom: false, override: { hidden: true } },
    ];
    const applied = await svc.load();
    assert.deepStrictEqual(applied.map((d) => d.key), ['fleet']);
    assert.equal(registry.getNode('employee').figures.x, undefined);
  });
});
