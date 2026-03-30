const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

/*
 * vehicleComplianceService requires mdb, taskService, and logger at top level.
 * Patch mdb singleton; patch taskService exports; logger is fine as-is.
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');
const taskService = require('../mongoose/services/taskServiceMongoose');

let createTaskCalls = [];
const origCreateTask = taskService.createTask;

function patchMdb({ vehicles = [], admins = [], existingTask = null } = {}) {
  createTaskCalls = [];
  taskService.createTask = mock.fn(async (data) => {
    createTaskCalls.push(data);
  });

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    vehicle: {
      find: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(vehicles)) })),
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
  };
}

const { checkComplianceAndCreateTasks, stop } = require('../mongoose/services/vehicleComplianceService');

/* ── tests ─────────────────────────────────────────────────────────── */
describe('vehicleComplianceService', () => {
  beforeEach(() => patchMdb());

  describe('checkComplianceAndCreateTasks', () => {
    it('returns early when Vehicle model not available', async () => {
      const origVehicle = mdb.INTERNAL.vehicle;
      mdb.INTERNAL.vehicle = undefined;
      const stats = await checkComplianceAndCreateTasks();
      assert.deepStrictEqual(stats, { created: 0, skipped: 0, errors: 0 });
      mdb.INTERNAL.vehicle = origVehicle;
    });

    it('returns early when no admin users found', async () => {
      patchMdb({ admins: [] });
      const stats = await checkComplianceAndCreateTasks();
      assert.equal(stats.created, 0);
    });

    it('creates tasks for expired MOT', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 10);
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{
          registrationNumber: 'AB12 CDE',
          make: 'Ford',
          model: 'Transit',
          motExpiryDate: past,
          insuranceExpiryDate: null,
          roadTaxExpiryDate: null,
          availabilityStatus: 'Available',
        }],
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.ok(stats.created >= 1);
      assert.ok(createTaskCalls.length >= 1);
      assert.ok(createTaskCalls[0].title.includes('EXPIRED'));
      assert.ok(createTaskCalls[0].title.includes('MOT'));
      assert.ok(createTaskCalls[0].title.includes('AB12 CDE'));
    });

    it('creates tasks for expiring insurance', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 15);
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{
          registrationNumber: 'XY34 FGH',
          make: 'Toyota',
          model: 'Hilux',
          motExpiryDate: null,
          insuranceExpiryDate: future,
          roadTaxExpiryDate: null,
        }],
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.ok(stats.created >= 1);
      assert.ok(createTaskCalls[0].title.includes('EXPIRING'));
      assert.ok(createTaskCalls[0].title.includes('Insurance'));
    });

    it('skips when task already exists (idempotent)', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 5);
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{
          registrationNumber: 'ZZ99 AAA',
          make: 'VW',
          model: 'Transporter',
          motExpiryDate: past,
        }],
        existingTask: { _id: 'existing' },
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.equal(stats.skipped, 1);
      assert.equal(createTaskCalls.length, 0);
    });

    it('creates tasks for multiple admin users', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 1);
      patchMdb({
        admins: [{ _id: 'admin1' }, { _id: 'admin2' }],
        vehicles: [{
          registrationNumber: 'AA11 BBB',
          make: 'Ford',
          model: 'Focus',
          motExpiryDate: past,
        }],
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.equal(stats.created, 2);
    });

    it('counts errors when task creation fails', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 1);
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{
          registrationNumber: 'ERR 001',
          make: 'Error',
          model: 'Car',
          motExpiryDate: past,
        }],
      });
      taskService.createTask = mock.fn(() => Promise.reject(new Error('fail')));

      const stats = await checkComplianceAndCreateTasks();
      assert.equal(stats.errors, 1);
    });
  });

  describe('stop', () => {
    it('does not throw even if not started', () => {
      stop();
    });
  });
});
