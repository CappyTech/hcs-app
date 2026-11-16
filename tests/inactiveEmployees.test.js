import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

/**
 * Leavers (employee status 'inactive') stay on file but shouldn't be offered
 * on new records or raise reminders: generic CRUD pickers hide them by default
 * (keeping whoever an edited record already points at), and H&S expiry
 * reminders skip them.
 */

process.env.ENCRYPTION_KEY ||= 'test-key';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);

let crud, hs;

before(async () => {
  crud = await imp('mongoose/controllers/CRUDController.js');
  hs = await imp('mongoose/services/healthSafetyComplianceService.js');
});

const empField = { ref: 'employee' };
const inactiveOut = { status: { $ne: 'inactive' } };

describe('referenceFilterFor', () => {
  it('hides inactive employees when the model sets no filter of its own', () => {
    assert.deepEqual(crud.referenceFilterFor('employeeId', empField, {}), inactiveOut);
  });

  it("uses the model's own filter when it has one", () => {
    const config = { referenceFilters: { siteManagers: { roles: { $in: ['siteManager'] } } } };
    assert.deepEqual(crud.referenceFilterFor('siteManagers', empField, config), { roles: { $in: ['siteManager'] } });
  });

  it('leaves other models unfiltered', () => {
    assert.deepEqual(crud.referenceFilterFor('vehicleId', { ref: 'vehicle' }, {}), {});
  });

  it('applies no filter for read views', () => {
    assert.deepEqual(crud.referenceFilterFor('employeeId', empField, {}, { skipFilters: true }), {});
  });

  it("keeps an edited record's current employee in the picker", () => {
    const id = new mongoose.Types.ObjectId();
    const f = crud.referenceFilterFor('employeeId', empField, {}, { keep: { employeeId: id } });
    assert.deepEqual(f, { $or: [inactiveOut, { _id: { $in: [id] } }] });
  });

  it('keeps every id of a multi-picker and ignores junk values', () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const f = crud.referenceFilterFor('assignedEmployees', empField, {}, { keep: { assignedEmployees: [a, { _id: b }, '', 'nope'] } });
    assert.deepEqual(f.$or[1], { _id: { $in: [a, b] } });
  });

  it('adds nothing when the record has no current value', () => {
    assert.deepEqual(crud.referenceFilterFor('employeeId', empField, {}, { keep: { employeeId: null } }), inactiveOut);
  });
});

describe('H&S reminders skip leavers', () => {
  const names = { employees: new Map([['a', { name: 'A', status: 'inactive' }], ['b', { name: 'B', status: 'active' }]]) };

  it('flags records about an inactive employee', () => {
    assert.equal(hs.isLeaver({ employeeId: 'a' }, names), true);
  });

  it('keeps active employees, subcontractors and named visitors', () => {
    assert.equal(hs.isLeaver({ employeeId: 'b' }, names), false);
    assert.equal(hs.isLeaver({ subcontractorId: 'x' }, names), false);
    assert.equal(hs.isLeaver({ personName: 'Visitor' }, names), false);
  });
});
