import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listSearchFields, listSearchFilter } from '../mongoose/controllers/listController.js';
import listConfig from '../mongoose/config/listControllerConfig.js';
import { ENTITIES } from '../mongoose/services/searchService.js';

/**
 * The list pages' search box. "Open in list" on /search hands its term to the
 * list (/purchases?search=…), so a list has to match what the search matched:
 * a supplier's name found 50 purchases on /search and none on /purchases.
 * Everything here is made up.
 */

// A model whose schema types each field the way the purchase schema does
const fakeModel = (types) => ({ schema: { path: (f) => (types[f] ? { instance: types[f] } : null) } });
const purchaseModel = fakeModel({ Number: 'Number', SupplierName: 'String', SupplierCode: 'String', SupplierReference: 'String' });

describe('the purchases list search', () => {
  it("searches the supplier's name and code as well as the number and reference", () => {
    const fields = listSearchFields(listConfig.purchase, 'purchase');
    for (const f of ['Number', 'SupplierName', 'SupplierCode', 'SupplierReference']) assert.ok(fields.includes(f), f);
  });

  it('a name matches by "contains" on the text fields, never on the number', () => {
    const filter = listSearchFilter(purchaseModel, listSearchFields(listConfig.purchase, 'purchase'), 'Example Supplies');
    const fields = filter.$or.map((c) => Object.keys(c)[0]);
    assert.deepEqual(fields, ['SupplierName', 'SupplierCode', 'SupplierReference']);
    assert.ok(filter.$or[0].SupplierName.test('EXAMPLE SUPPLIES LTD'));
  });

  it('a number matches the purchase number exactly, and the text fields too', () => {
    const filter = listSearchFilter(purchaseModel, ['Number', 'SupplierReference'], '1234');
    assert.deepEqual(filter.$or[0], { Number: 1234 });
    assert.ok(filter.$or[1].SupplierReference.test('SI-1234'));
  });
});

describe('every list search', () => {
  it('a list with no searchFields of its own uses the global search fields for its model', () => {
    const invoice = ENTITIES.find((e) => e.model === 'invoice');
    assert.deepEqual(listSearchFields({}, 'invoice'), invoice.fields);
    assert.deepEqual(listSearchFields({ linkField: 'name' }, 'not-searched'), ['name']);
    assert.deepEqual(listSearchFields({}, 'not-searched'), ['title']);
    assert.deepEqual(listSearchFields({ searchFields: ['Code'] }, 'invoice'), ['Code'], 'its own fields win');
  });

  it('a term no field can match finds nothing, rather than being ignored', () => {
    const filter = listSearchFilter(fakeModel({ Number: 'Number' }), ['Number'], 'Example');
    assert.deepEqual(filter, { _id: { $in: [] } });
  });
});
