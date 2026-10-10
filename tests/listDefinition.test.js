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
