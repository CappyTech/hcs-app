import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * holidayCarryOverService requires mdb, taxService (pure) and, lazily,
 * holidayAccrualService (which reads the current-year record through the same
 * mocked employeeHoliday model). findOne is awaited both directly and via
 * .lean(), so the mock returns a promise that also exposes .lean().
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taxService from '../services/taxService.js';

function queryResult(value) {
  const p = Promise.resolve(value);
  p.lean = () => Promise.resolve(value);
  return p;
}

let updateOneCalls = [];

function patchMdb({ employees = [], prevRecord = null, currentRecord = null } = {}) {
  updateOneCalls = [];

  const { taxYear } = taxService.calculateTaxYearAndMonth(new Date());
  const previous = taxService.getTaxYearStartEnd(taxYear - 1);

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    employee: {
      find: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(employees)) })),
      findById: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(employees[0] || null)) })),
    },
    employeeHoliday: {
      findOne: mock.fn((query) => {
        const isPrevious = query.periodStart && query.periodStart.getTime() === previous.start.getTime();
        return queryResult(isPrevious ? prevRecord : currentRecord);
      }),
      updateOne: mock.fn(async (filter, update) => {
        updateOneCalls.push({ filter, update });
        return { modifiedCount: 1 };
      }),
    },
  };
}

import { applyCarryOverOnce } from '../mongoose/services/holidayCarryOverService.js';

describe('holidayCarryOverService', () => {
  beforeEach(() => patchMdb());

  it('returns early when models not available', async () => {
    const orig = mdb.INTERNAL.employeeHoliday;
    mdb.INTERNAL.employeeHoliday = undefined;
    const stats = await applyCarryOverOnce();
    assert.deepStrictEqual(stats, { processed: 0, applied: 0, skipped: 0, errors: 0 });
    mdb.INTERNAL.employeeHoliday = orig;
  });

  it('skips employees with no previous-year record', async () => {
    patchMdb({
      employees: [{ _id: 'e1', name: 'Jane', status: 'active' }],
      prevRecord: null,
    });
    const stats = await applyCarryOverOnce();
    assert.equal(stats.processed, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(updateOneCalls.length, 0);
  });

  it('carries over unused days capped by policy', async () => {
    patchMdb({
      employees: [{
        _id: 'e1', name: 'Jane', status: 'active',
        holidayPolicy: { carryOverMaxDays: 5, carryOverMaxHours: 0 },
      }],
      prevRecord: { entitlementDays: 28, carryOverDays: 0, takenDays: 20, entitlementHours: null },
      currentRecord: { _id: 'cur1', carryOverDays: 0, carryOverHours: 0, carryOverAppliedAt: null },
    });

    const stats = await applyCarryOverOnce();
    assert.equal(stats.applied, 1);
    assert.equal(updateOneCalls.length, 1);
    // 28 + 0 − 20 = 8 unused, capped at 5
    assert.equal(updateOneCalls[0].update.$set.carryOverDays, 5);
    assert.ok(updateOneCalls[0].update.$set.carryOverAppliedAt instanceof Date);
  });

  it('carries the full unused amount when below the cap', async () => {
    patchMdb({
      employees: [{
        _id: 'e1', name: 'Jane', status: 'active',
        holidayPolicy: { carryOverMaxDays: 10 },
      }],
      prevRecord: { entitlementDays: 28, carryOverDays: 0, takenDays: 25 },
      currentRecord: { _id: 'cur1', carryOverDays: 0, carryOverHours: 0, carryOverAppliedAt: null },
    });

    await applyCarryOverOnce();
    assert.equal(updateOneCalls[0].update.$set.carryOverDays, 3);
  });

  it('does not reapply once marked applied', async () => {
    patchMdb({
      employees: [{ _id: 'e1', name: 'Jane', status: 'active', holidayPolicy: { carryOverMaxDays: 5 } }],
      prevRecord: { entitlementDays: 28, takenDays: 0 },
      currentRecord: { _id: 'cur1', carryOverDays: 0, carryOverHours: 0, carryOverAppliedAt: new Date() },
    });

    const stats = await applyCarryOverOnce();
    assert.equal(stats.applied, 0);
    assert.equal(stats.skipped, 1);
    assert.equal(updateOneCalls.length, 0);
  });

  it('leaves manually set carry-over alone', async () => {
    patchMdb({
      employees: [{ _id: 'e1', name: 'Jane', status: 'active', holidayPolicy: { carryOverMaxDays: 5 } }],
      prevRecord: { entitlementDays: 28, takenDays: 0 },
      currentRecord: { _id: 'cur1', carryOverDays: 2, carryOverHours: 0, carryOverAppliedAt: null },
    });

    const stats = await applyCarryOverOnce();
    assert.equal(stats.applied, 0);
    assert.equal(updateOneCalls.length, 0);
  });

  it('marks processed with zero carry-over when policy cap is 0 (default)', async () => {
    patchMdb({
      employees: [{ _id: 'e1', name: 'Jane', status: 'active', holidayPolicy: {} }],
      prevRecord: { entitlementDays: 28, takenDays: 10 },
      currentRecord: { _id: 'cur1', carryOverDays: 0, carryOverHours: 0, carryOverAppliedAt: null },
    });

    const stats = await applyCarryOverOnce();
    assert.equal(stats.applied, 0);
    assert.equal(stats.skipped, 1);
    assert.equal(updateOneCalls.length, 1);
    assert.equal(updateOneCalls[0].update.$set.carryOverDays, 0);
    assert.ok(updateOneCalls[0].update.$set.carryOverAppliedAt instanceof Date);
  });
});
