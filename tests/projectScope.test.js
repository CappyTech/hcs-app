import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import projectScope from '../mongoose/services/projectScopeService.js';
import { scopeQuery, matchesFilter } from '../services/dataScopingService.js';

const oid = () => new mongoose.Types.ObjectId();

// A tiny stand-in for a Mongoose model: find(filter).select().lean()
function stubModel(rows, seen) {
  return {
    find(filter) {
      if (seen) seen.push(filter);
      const chain = { select: () => chain, lean: async () => rows };
      return chain;
    },
  };
}

describe('projectScopeService.resolve', () => {
  it('collects contracts naming the user (not Completed) and what hangs off them', async () => {
    const user = { _id: oid() };
    const [c1, c2, p1, q1, l1] = [oid(), oid(), oid(), oid(), oid()];
    const seen = [];
    const db = {
      INTERNAL: { contract: stubModel([
        { _id: c1, projectId: p1, quoteId: q1, locationId: l1 },
        { _id: c2, projectId: p1 },
      ], seen) },
      REST: { project: stubModel([{ _id: p1, Number: 42 }]) },
    };
    const sets = await projectScope.resolve(user, db);
    assert.deepEqual(seen[0], { siteManagers: user._id, status: { $ne: 'Completed' } });
    assert.deepEqual(sets.contractIds.map(String), [c1, c2].map(String));
    assert.deepEqual(sets.projectIds.map(String), [String(p1)], 'deduplicated');
    assert.deepEqual(sets.projectNumbers, [42]);
    assert.deepEqual(sets.quoteIds.map(String), [String(q1)]);
    assert.deepEqual(sets.locationIds.map(String), [String(l1)]);
  });

  it('fails closed: no user, no model or a database error give empty sets', async () => {
    const empty = { contractIds: [], projectIds: [], projectNumbers: [], quoteIds: [], locationIds: [] };
    assert.deepEqual(await projectScope.resolve(null, {}), empty);
    assert.deepEqual(await projectScope.resolve({ _id: oid() }, {}), empty);
    const broken = { INTERNAL: { contract: { find() { throw new Error('down'); } } } };
    assert.deepEqual(await projectScope.resolve({ _id: oid() }, broken), empty);
  });

  it('builds a filter per model, null where a model has no site mapping', () => {
    const sets = { contractIds: ['c'], projectIds: ['p'], projectNumbers: [7], quoteIds: [], locationIds: [] };
    assert.deepEqual(projectScope.filterFor('assignment', sets), { contractId: { $in: ['c'] } });
    assert.deepEqual(projectScope.filterFor('attendance', sets),
      { $or: [{ contractId: { $in: ['c'] } }, { projectId: { $in: ['p'] } }] });
    assert.deepEqual(projectScope.filterFor('purchase', sets), { ProjectNumber: { $in: [7] } });
    assert.equal(projectScope.filterFor('customer', sets), null);
  });
});

describe('scopeQuery with project scope', () => {
  const c1 = oid();
  const p1 = oid();
  const sets = { contractIds: [c1], projectIds: [p1], projectNumbers: [42], quoteIds: [], locationIds: [] };
  const req = (user) => ({ user, _projectScope: Promise.resolve(sets) });

  it('a Site Manager reads only their sites', async () => {
    const sm = { _id: oid(), role: 'none', roles: ['siteManager'] };
    assert.deepEqual(await scopeQuery(req(sm), 'assignment', 'l'), { contractId: { $in: [c1] } });
    assert.deepEqual(await scopeQuery(req(sm), 'attendance', 'r'),
      { $or: [{ contractId: { $in: [c1] } }, { projectId: { $in: [p1] } }] });
    // No write grant at project scope yet
    assert.equal(await scopeQuery(req(sm), 'attendance', 'u'), null);
    // Commercial needs the flag
    assert.equal(await scopeQuery(req(sm), 'purchase', 'l'), null);
    assert.deepEqual(await scopeQuery(req({ ...sm, canSeeValues: true }), 'purchase', 'l'), { ProjectNumber: { $in: [42] } });
  });

  it('an employee who is also a Site Manager sees their own records or their sites', async () => {
    const empId = oid();
    const user = { _id: oid(), role: 'employee', employeeId: empId, roles: ['siteManager'] };
    const f = await scopeQuery(req(user), 'attendance', 'r');
    assert.deepEqual(f, { $or: [
      { employeeId: empId },
      { $or: [{ contractId: { $in: [c1] } }, { projectId: { $in: [p1] } }] },
    ] });
    // project: false keeps the old own-records behaviour (the weekly view)
    assert.deepEqual(await scopeQuery(req(user), 'attendance', 'r', { project: false }), { employeeId: empId });
  });

  it('an unscoped grant still lifts all scoping', async () => {
    const user = { _id: oid(), role: 'employee', roles: ['siteManager', 'contractsManager'] };
    assert.deepEqual(await scopeQuery(req(user), 'attendance', 'r'), {});
  });
});

describe('matchesFilter', () => {
  const c1 = oid();
  it('handles equality, $in, $or, $and and populated refs', () => {
    assert.equal(matchesFilter({ a: 1 }, { a: 1 }), true);
    assert.equal(matchesFilter({ a: 2 }, { a: 1 }), false);
    assert.equal(matchesFilter({ contractId: c1 }, { contractId: { $in: [c1] } }), true);
    assert.equal(matchesFilter({ contractId: { _id: c1, title: 'x' } }, { contractId: { $in: [String(c1)] } }), true);
    assert.equal(matchesFilter({ contractId: oid() }, { contractId: { $in: [c1] } }), false);
    assert.equal(matchesFilter({ projectId: c1 }, { $or: [{ contractId: { $in: [] } }, { projectId: { $in: [c1] } }] }), true);
    assert.equal(matchesFilter({ a: 1, b: 2 }, { $and: [{ a: 1 }, { b: 3 }] }), false);
    assert.equal(matchesFilter({}, { contractId: { $in: [c1] } }), false, 'a missing field never matches');
    assert.equal(matchesFilter({ a: 1 }, null), false);
    assert.equal(matchesFilter({ a: 1 }, {}), true);
  });
});
