import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * hrComplianceService requires mdb, taskService, and logger at top level.
 * Patch mdb singleton; patch taskService exports (same pattern as the
 * vehicleComplianceService tests).
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';

let createTaskCalls = [];

function patchMdb({ employees = [], admins = [], existingTask = null } = {}) {
  createTaskCalls = [];
  taskService.createTask = mock.fn(async (data) => {
    createTaskCalls.push(data);
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
    task: {
      findOne: mock.fn(() => ({
        select: mock.fn(() => ({
          lean: mock.fn(() => Promise.resolve(existingTask)),
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

  it('creates a task for an expired contract end date', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{
        name: 'Jane Doe',
        contract: { endDate: daysFromNow(-5) },
      }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 1);
    assert.ok(createTaskCalls[0].title.includes('EXPIRED'));
    assert.ok(createTaskCalls[0].title.includes('Contract end'));
    assert.ok(createTaskCalls[0].title.includes('Jane Doe'));
  });

  it('creates a task for an expiring right-to-work check', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{
        name: 'John Smith',
        rightToWork: { expiryDate: daysFromNow(14) },
      }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 1);
    assert.ok(createTaskCalls[0].title.includes('EXPIRING'));
    assert.ok(createTaskCalls[0].title.includes('Right to work'));
  });

  it('ignores dates beyond the horizon', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{
        name: 'Far Future',
        contract: { endDate: daysFromNow(120) },
      }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 0);
  });

  it('skips when an uncompleted task already exists (idempotent)', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{
        name: 'Jane Doe',
        contract: { endDate: daysFromNow(-1) },
      }],
      existingTask: { _id: 'existing' },
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.skipped, 1);
    assert.equal(createTaskCalls.length, 0);
  });

  it('creates one task per item per admin', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }, { _id: 'admin2' }],
      employees: [{
        name: 'Jane Doe',
        contract: { endDate: daysFromNow(3) },
        rightToWork: { expiryDate: daysFromNow(7) },
      }],
    });

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.created, 4); // 2 items × 2 admins
  });

  it('counts errors when task creation fails', async () => {
    patchMdb({
      admins: [{ _id: 'admin1' }],
      employees: [{ name: 'Err Case', contract: { endDate: daysFromNow(-1) } }],
    });
    taskService.createTask = mock.fn(() => Promise.reject(new Error('fail')));

    const stats = await checkExpiriesAndCreateTasks();
    assert.equal(stats.errors, 1);
  });
});
