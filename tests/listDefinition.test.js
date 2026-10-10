import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import registry from '../mongoose/config/overviews/index.js';
import { generateHeaders } from '../mongoose/controllers/listController.js';

describe('list page columns', () => {
  afterEach(() => registry.applyOverrides([]));

  it('uses the columns defined on the overview, whatever the first record holds', () => {
    // A legacy record without most fields still gets every defined column
    const headers = generateHeaders({ _id: 'x', name: 'Test Person', contactName: 'old' }, {}, 'employee');
    const defined = registry.getNode('employee').list.columns;
    assert.deepStrictEqual(headers, defined.map((c) => ({ key: c.field, label: c.label })));
    assert.ok(!headers.some((h) => h.key === 'contactName'));
  });

  it('follows a stored change, and falls back to the older rules without a definition', () => {
    registry.applyOverrides([{ kind: 'node', key: 'employee', override: { list: { columns: [{ field: 'status', label: 'State' }] } } }]);
    assert.deepStrictEqual(generateHeaders({ name: 'A', status: 'active' }, {}, 'employee'), [{ key: 'status', label: 'State' }]);
    registry.applyOverrides([{ kind: 'node', key: 'employee', override: { list: null } }]);
    const auto = generateHeaders({ _id: 'x', name: 'A', status: 'active' }, { fieldOrder: ['status'] }, 'employee');
    assert.deepStrictEqual(auto.map((h) => h.key), ['status', 'name']);
  });

  it('leaves lists without a definition alone', () => {
    const headers = generateHeaders({ _id: 'x', Name: 'A', Code: 'B' }, { labelOverrides: { Code: 'Ref' } }, 'nominal');
    assert.deepStrictEqual(headers, [{ key: 'Name', label: 'Name' }, { key: 'Code', label: 'Ref' }]);
  });
});

describe('list sort, tabs and filters', async () => {
  const defs = (await import('../mongoose/services/listDefinitionService.js')).default;
  afterEach(() => registry.applyOverrides([]));

  it('uses listControllerConfig until a definition overrides it', () => {
    const before = defs.listConfig('employee');
    assert.equal(before.tabsby, 'status');
    registry.applyOverrides([{ kind: 'node', key: 'employee', override: { list: {
      sort: { hireDate: -1 },
      tabs: { by: 'type', values: [{ value: 'employee', label: 'Staff' }] },
      filters: [{ field: 'ir35', label: 'IR35', type: 'boolean' }],
    } } }]);
    const after = defs.listConfig('employee');
    assert.equal(after.sortField, 'hireDate');
    assert.equal(after.sortOrder, -1);
    assert.equal(after.tabsby, 'type');
    assert.deepStrictEqual(after.tabsValues, [{ value: 'all', label: 'All' }, { value: 'employee', label: 'Staff' }]);
    assert.deepStrictEqual(after.filters, [{ field: 'ir35', label: 'IR35', type: 'boolean' }]);
    // Links, layout and the rest still come from listControllerConfig
    assert.equal(after.linkField, before.linkField);
    assert.ok(after.columns === undefined && registry.getNode('employee').list.columns.length > 0);
  });

  it('can turn tabs off, and a null sort goes back to the code default', () => {
    registry.applyOverrides([{ kind: 'node', key: 'employee', override: { list: { tabs: false, sort: null } } }]);
    const cfg = defs.listConfig('employee');
    assert.equal(cfg.tabsby, undefined);
    assert.equal(cfg.sortField, 'name');
  });

  it('describes the current settings for the editor', () => {
    const c = defs.currentControls('task');
    assert.deepStrictEqual(c.sort, { dueDate: 1 });
    assert.equal(c.tabs.by, 'completed');
    assert.ok(c.tabs.values.every((v) => v.value !== 'all'));
    assert.ok(c.filters.some((f) => f.field === 'source' && f.type === 'select'));
  });
});
