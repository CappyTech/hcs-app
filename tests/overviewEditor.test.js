import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import registry from '../mongoose/config/overviews/index.js';
import svc from '../mongoose/services/overviewConfigService.js';
import editor from '../mongoose/services/overviewEditorService.js';
import ctrl from '../mongoose/controllers/overviewEditorController.js';
import employeeDef from '../mongoose/models/mongoose/INTERNAL/employee.js';
import taskDef from '../mongoose/models/mongoose/INTERNAL/task.js';

const model = (def) => ({ modelName: def.modelName, schema: def.schema, find: () => ({}) });

let stored = [];
function patch() {
  stored = [];
  const Store = function Store(data) {
    Object.assign(this, data);
    this.markModified = () => {};
    this.save = async () => { stored = stored.filter((d) => !(d.kind === this.kind && d.key === this.key)).concat([{ kind: this.kind, key: this.key, custom: this.custom, override: this.override }]); };
    this.deleteOne = async () => { stored = stored.filter((d) => !(d.kind === this.kind && d.key === this.key)); };
  };
  Store.find = () => ({ lean: async () => stored.map((d) => ({ ...d })) });
  Store.findOne = async (q) => { const d = stored.find((x) => x.kind === q.kind && x.key === q.key); return d ? new Store(d) : null; };
  mdb.INTERNAL = { ...mdb.INTERNAL, overviewConfig: Store, employee: model(employeeDef), task: model(taskDef) };
}

function call(handler, { params = {}, body = {} } = {}) {
  const flashes = [];
  let redirected = null;
  const req = { params, body, user: { _id: 'admin-1', role: 'admin' }, flash: (t, m) => flashes.push([t, m]) };
  const res = { redirect: (u) => { redirected = u; } };
  return handler(req, res, () => {}).then(() => ({ flashes, redirected }));
}

describe('filter builder', () => {
  beforeEach(patch);

  it('round-trips the filters people build', () => {
    const where = {
      status: 'active',
      type: { $in: ['full-time', 'part-time'] },
      hireDate: { $withinPastDays: 365 },
      managerId: { $set: true },
      'contract.endDate': { $notAfterDays: -30 },
      'contract.hoursPerWeek': { $gte: 20 },
    };
    const rows = editor.whereToRows(where);
    assert.ok(rows.some((r) => r.op === '$notAfterDays:ago' && r.value === '30'));
    assert.deepStrictEqual(editor.rowsToWhere(rows, 'employee'), where);
  });

  it('reads "is empty" for a null condition', () => {
    assert.deepStrictEqual(editor.whereToRows({ managerId: null }), [{ field: 'managerId', op: '$set:false', value: '' }]);
  });

  it("can't show filters that combine conditions, so leaves them alone", () => {
    assert.equal(editor.whereToRows({ $or: [{ a: 1 }] }), null);
    assert.equal(editor.whereToRows({ name: { $regex: 'x' } }), null);
  });

  it('explains values that don\'t fit the field', () => {
    assert.throws(() => editor.rowsToWhere([{ field: 'ir35', op: 'is', value: 'maybe' }], 'employee'), /yes or no/);
    assert.throws(() => editor.rowsToWhere([{ field: 'hireDate', op: 'is', value: '2026-01-01' }], 'employee'), /within … days/);
    assert.throws(() => editor.rowsToWhere([{ field: 'hireDate', op: '$withinPastDays', value: '0' }], 'employee'), /whole number of days/);
    assert.throws(() => editor.rowsToWhere([{ field: 'nope', op: 'is', value: 'x' }], 'employee'), /isn't a field/);
  });

  it('never offers secret fields', () => {
    assert.ok(!editor.schemaFields('employee').some((f) => /password|totpSecret/i.test(f.path)));
  });
});

describe('editing through the forms', () => {
  beforeEach(async () => { patch(); await svc.load(); });
  afterEach(() => registry.applyOverrides([]));

  it('stores only what changed: a label, a new figure, and where it shows', async () => {
    const node = registry.getNode('employee');
    const rows = (id) => Object.fromEntries((editor.whereToRows(node.figures[id].where) || []).map((r, i) => [i, r]));
    const body = {
      label_many: 'People', label_one: 'Person', icon: node.icon, description: node.description,
      parent_pick: { human: 'on' }, parent_order: { human: '0' },
      fig: Object.fromEntries(Object.entries(node.figures).map(([id, f]) => [id, {
        label: f.label, hint: f.hint || '', severity: f.severity || '', ...(editor.whereToRows(f.where) ? {} : { keepFilter: '1' }),
      }])),
      cond: {
        ...Object.fromEntries(Object.keys(node.figures).map((id) => [id, rows(id)])),
        __new: { 0: { field: 'type', op: 'is', value: 'part-time' }, 1: { field: 'status', op: 'is', value: 'active' } },
      },
      newfig: { id: 'partTime', label: 'Part-time staff' },
      sum_pick: Object.fromEntries([...node.summary, 'partTime'].map((r) => [`employee.${r}`, 'on'])),
      sum_order: Object.fromEntries([...node.summary, 'partTime'].map((r, i) => [`employee.${r}`, String(i)])),
      ov_pick: Object.fromEntries(node.overview.figures.map((r) => [`employee.${r}`, 'on'])),
      ov_order: Object.fromEntries(node.overview.figures.map((r, i) => [`employee.${r}`, String(i)])),
      rel_pick: Object.fromEntries(node.overview.related.map((r) => [r, 'on'])),
      rel_order: Object.fromEntries(node.overview.related.map((r, i) => [r, String(i)])),
      panel_pick: Object.fromEntries((node.overview.panels || []).map((p) => [p, 'on'])),
      bd: Object.fromEntries(node.overview.breakdowns.map((b, i) => [i, { label: b.label }])),
      list: Object.fromEntries(node.overview.lists.map((l, i) => [i, { title: l.title || '', limit: String(l.limit), order: String(i) }])),
    };
    const { flashes, redirected } = await call(ctrl.postNode, { params: { key: 'employee' }, body });
    assert.deepStrictEqual(flashes, [['success', 'Saved People.']]);
    assert.equal(redirected, '/admin/overviews/node/employee');
    assert.equal(stored.length, 1);
    const ov = stored[0].override;
    assert.deepStrictEqual(Object.keys(ov).sort(), ['figures', 'label', 'summary']);
    assert.deepStrictEqual(ov.figures, { partTime: { label: 'Part-time staff', where: { type: 'part-time', status: 'active' } } });
    assert.equal(registry.getNode('employee').label.many, 'People');
  });

  it('sets the list page columns, and goes back to automatic columns', async () => {
    const node = registry.getNode('employee');
    const base = {
      label_many: node.label.many, label_one: node.label.one, icon: node.icon, description: node.description,
      parent_pick: { human: 'on' }, parent_order: { human: '0' },
      fig: Object.fromEntries(Object.entries(node.figures).map(([id, f]) => [id, {
        label: f.label, hint: f.hint || '', severity: f.severity || '', keepFilter: '1',
      }])),
      sum_pick: Object.fromEntries(node.summary.map((r) => [`employee.${r}`, 'on'])),
      sum_order: Object.fromEntries(node.summary.map((r, i) => [`employee.${r}`, String(i)])),
      ov_pick: Object.fromEntries(node.overview.figures.map((r) => [`employee.${r}`, 'on'])),
      ov_order: Object.fromEntries(node.overview.figures.map((r, i) => [`employee.${r}`, String(i)])),
      rel_pick: Object.fromEntries(node.overview.related.map((r) => [r, 'on'])),
      rel_order: Object.fromEntries(node.overview.related.map((r, i) => [r, String(i)])),
      panel_pick: Object.fromEntries((node.overview.panels || []).map((p) => [p, 'on'])),
      bd: Object.fromEntries(node.overview.breakdowns.map((b, i) => [i, { label: b.label }])),
      list: Object.fromEntries(node.overview.lists.map((l, i) => [i, { title: l.title || '', limit: String(l.limit), order: String(i) }])),
    };
    const lcol = {
      0: { field: 'name', label: 'Name', order: '1' },
      1: { field: 'status', label: '', order: '0' },
      2: { field: 'email', label: 'Email', order: '2', remove: 'on' },
      3: { field: '', label: '' },
    };
    let out = await call(ctrl.postNode, { params: { key: 'employee' }, body: { ...base, list_mode: 'defined', lcol } });
    assert.equal(out.flashes[0][0], 'success');
    assert.deepStrictEqual(stored[0].override.list, { columns: [{ field: 'status', label: 'status' }, { field: 'name', label: 'Name' }] });
    assert.deepStrictEqual(registry.getNode('employee').list.columns.map((c) => c.field), ['status', 'name']);

    out = await call(ctrl.postNode, { params: { key: 'employee' }, body: { ...base, list_mode: 'auto' } });
    assert.equal(out.flashes[0][0], 'success');
    assert.equal(stored[0].override.list, null);
    assert.equal(registry.getNode('employee').list, undefined);

    out = await call(ctrl.postNode, { params: { key: 'employee' }, body: { ...base, list_mode: 'defined', lcol: { 0: { field: '' } } } });
    assert.equal(out.flashes[0][0], 'error');
    assert.match(out.flashes[0][1], /at least one column/);
  });

  it('refuses a broken change with a plain message and stores nothing', async () => {
    const { flashes } = await call(ctrl.postNode, {
      params: { key: 'employee' },
      body: { label_many: 'Employees', newfig: { id: 'x', label: 'X' }, cond: { __new: { 0: { field: 'ir35', op: 'is', value: 'perhaps' } } } },
    });
    assert.equal(flashes[0][0], 'error');
    assert.match(flashes[0][1], /yes or no/);
    assert.equal(stored.length, 0);
  });

  it('moving an overview into another area keeps both sides consistent', async () => {
    const area = registry.getArea('fleet');
    const body = {
      label: area.label, icon: area.icon, description: area.description,
      child_pick: Object.fromEntries([...area.children, 'task'].map((c) => [c, 'on'])),
      child_order: Object.fromEntries([...area.children, 'task'].map((c, i) => [c, String(i)])),
    };
    const { flashes } = await call(ctrl.postArea, { params: { key: 'fleet' }, body });
    assert.deepStrictEqual(flashes, [['success', 'Saved Fleet.']]);
    assert.ok(registry.getArea('fleet').children.includes('task'));
    assert.deepStrictEqual(registry.getNode('task').parents, ['human', 'fleet']);
    assert.deepStrictEqual(registry.validate(), []);
  });

  it('creates an area and an overview in it, then deletes them cleanly', async () => {
    let r = await call(ctrl.postNewArea, { body: { key: 'operations', label: 'Operations', icon: 'bi-gear', roles: ['admin', 'accountant'] } });
    assert.equal(r.redirected, '/admin/overviews/area/operations');
    r = await call(ctrl.postNewNode, { body: { key: 'opsTasks', model: 'task', label_many: 'Ops tasks', area: 'operations', listPath: '/tasks', roles: ['admin'] } });
    assert.equal(r.redirected, '/admin/overviews/node/opsTasks');
    assert.deepStrictEqual(registry.getArea('operations').children, ['opsTasks']);
    assert.equal(registry.getNodeByOverviewPath('/overview/opsTasks').id, 'opsTasks');
    assert.deepStrictEqual(registry.validate(), []);

    await call(ctrl.postNodeReset, { params: { key: 'opsTasks' } });
    assert.equal(registry.getNode('opsTasks'), null);
    await call(ctrl.postAreaReset, { params: { key: 'operations' } });
    assert.equal(registry.getArea('operations'), null);
    assert.equal(stored.length, 0);
  });

  it('saving an unchanged form stores nothing (so defaults keep flowing)', async () => {
    const area = registry.getArea('human');
    await call(ctrl.postArea, { params: { key: 'human' }, body: {
      label: area.label, icon: area.icon, description: area.description,
      child_pick: Object.fromEntries(area.children.map((c) => [c, 'on'])),
      child_order: Object.fromEntries(area.children.map((c, i) => [c, String(i)])),
    } });
    assert.equal(stored.length, 0);
  });
});
