import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * hrComplianceService requires mdb, taskService, and logger at top level.
 * Patch mdb singleton; patch taskService exports (same pattern as the
 * vehicleComplianceService tests). The task rules themselves are covered in
 * taskService.test.js.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';

let ensureCalls = [];
let resolveCalls = [];

function patchMdb({ employees = [], admins = [] } = {}) {
  ensureCalls = [];
  resolveCalls = [];
  taskService.ensureSystemTask = mock.fn(async (args) => {
    ensureCalls.push(args);
    return { created: args.userIds.length, updated: 0, skipped: 0 };
  });
  taskService.resolveStaleSystemTasks = mock.fn(async (prefix, keys) => {
    resolveCalls.push({ prefix, keys: [...keys] });
    return 0;
  });

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    employee: {
      find: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(employees)) })),
    },
    user: {
      find: mock.fn(() => ({
        select: mock.fn(() => ({
          lean: mock.fn(() => Promise.resolve(admins)),
        })),
      })),
    },
    // Notification model unavailable → enqueue is skipped quietly
    notification: undefined,
  };
}

import { checkExpiriesAndCreateTasks } from '../mongoose/services/hrComplianceService.js';

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

describe('hrComplianceService', () => {
  beforeEach(() => patchMdb());

  it('returns early when models not available', async () => {
    const origEmployee = mdb.INTERNAL.employee;
    mdb.INTERNAL.employee = undefined;
    const stats = await checkExpiriesAndCreateTasks();
    assert.deepStrictEqual(stats, { created: 0, skipped: 0, errors: 0 });
    mdb.INTERNAL.employee = origEmployee;
  });

  it('returns early when no admin users found', async () => {
    patchMdb({ admins: [] });
    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 0);
  });

  it('asks for an EXPIRED reminder for an expired contract end date', async () => {
    const end = daysFromNow(-5);
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{ _id: 'e1', name: 'Jane Doe', contract: { endDate: end } }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 1);
    assert.equal(ensureCalls[0].title, '[EXPIRED] Contract end – Jane Doe');
    assert.equal(ensureCalls[0].systemKey, `employee:e1:contract.endDate:${end.toISOString().slice(0, 10)}`);
    assert.equal(ensureCalls[0].priority, 'high');
    assert.ok(ensureCalls[0].legacyTitles.includes('[EXPIRING] Contract end – Jane Doe'));
  });

  it('asks for an EXPIRING reminder for a right-to-work check due soon', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{ _id: 'e2', name: 'John Smith', rightToWork: { expiryDate: daysFromNow(14) } }],
    });

    await checkExpiriesAndCreateTasks();
    assert.ok(ensureCalls[0].title.startsWith('[EXPIRING] Right to work'));
    assert.ok(ensureCalls[0].systemKey.startsWith('employee:e2:rightToWork.expiryDate:'));
  });

  it('ignores dates beyond the horizon', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{ _id: 'e3', name: 'Far Future', contract: { endDate: daysFromNow(120) } }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 0);
    assert.equal(ensureCalls.length, 0);
    assert.deepStrictEqual(resolveCalls[0].keys, []); // any open reminder for it gets closed
  });

  it('one reminder per item, shared by every admin', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }, { _id: 'admin2' }],
      employees: [{
        _id: 'e4',
        name: 'Jane Doe',
        contract: { endDate: daysFromNow(3) },
        rightToWork: { expiryDate: daysFromNow(7) },
      }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(ensureCalls.length, 2);
    assert.equal(stats.created, 4); // 2 items × 2 admins
    assert.equal(resolveCalls[0].prefix, 'employee:');
    assert.equal(resolveCalls[0].keys.length, 2);
  });

  it('counts errors and closes nothing when a reminder fails', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{ _id: 'e5', name: 'Err Case', contract: { endDate: daysFromNow(-1) } }],
    });
    taskService.ensureSystemTask = mock.fn(() => Promise.reject(new Error('fail')));

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.errors, 1);
    assert.equal(resolveCalls.length, 0);
  });
});
