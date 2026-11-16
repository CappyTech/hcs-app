import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { buildLookupFilter } from '../mongoose/controllers/listController.js';

// A project can be pointed at by its Mongo _id or its numeric KashFlow Id
const Project = mongoose.model(
  'lookupFilterProject',
  new mongoose.Schema({ Id: Number, Name: String }),
);
const castsCleanly = (filter) => Project.find(filter).cast(Project, filter);

describe('field transform lookup filter', () => {
  const oid = new mongoose.Types.ObjectId();

  it('asks a number field only for numeric values, so ObjectIds no longer break the query', () => {
    const filter = buildLookupFilter(Project, ['_id', 'Id'], [oid]);
    assert.deepStrictEqual(filter, { _id: { $in: [oid] } });
    assert.doesNotThrow(() => castsCleanly(filter));
  });

  it('matches a numeric KashFlow Id on Id only', () => {
    const filter = buildLookupFilter(Project, ['_id', 'Id'], ['42', 7]);
    assert.deepStrictEqual(filter, { Id: { $in: [42, 7] } });
    assert.doesNotThrow(() => castsCleanly(filter));
  });

  it('splits mixed values between the fields that can hold them', () => {
    const filter = buildLookupFilter(Project, ['_id', 'Id'], [oid, 42]);
    assert.deepStrictEqual(filter, { $or: [{ _id: { $in: [oid] } }, { Id: { $in: [42] } }] });
    assert.doesNotThrow(() => castsCleanly(filter));
  });

  it('returns null when no field can hold any value', () => {
    assert.equal(buildLookupFilter(Project, ['_id', 'Id'], ['not-an-id']), null);
  });

  it('leaves string fields untouched', () => {
    assert.deepStrictEqual(buildLookupFilter(Project, ['Name'], ['x']), { Name: { $in: ['x'] } });
  });
});
