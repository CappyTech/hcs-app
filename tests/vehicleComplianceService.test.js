import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * vehicleComplianceService requires mdb, taskService, and logger at top level.
 * Patch mdb singleton; patch taskService exports; logger is fine as-is.
 * The task rules themselves (dedupe, rewording, closing) are covered by the
 * ensureSystemTask/resolveStaleSystemTasks tests in taskService.test.js; here
 * we check what the scan asks for.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';
import logger from '../services/loggerService.js';

let ensureCalls = [];
let resolveCalls = [];

function patchMdb({ vehicles = [], admins = [], ensureResult = null } = {}) {
  ensureCalls = [];
  resolveCalls = [];
  taskService.ensureSystemTask = mock.fn(async (args) => {
    ensureCalls.push(args);
    return ensureResult || { created: args.userIds.length, updated: 0, skipped: 0 };
  });
  taskService.resolveStaleSystemTasks = mock.fn(async (prefix, keys) => {
    resolveCalls.push({ prefix, keys: [...keys] });
    return 0;
  });

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    vehicle: {
      // Each compliance field queries separately; only return vehicles with that field set.
      find: mock.fn((q) => ({
        lean: mock.fn(() => Promise.resolve(vehicles.filter((v) => v[Object.keys(q)[0]]))),
      })),
    },
    user: {
      find: mock.fn(() => ({
        select: mock.fn(() => ({
          lean: mock.fn(() => Promise.resolve(admins)),
        })),
      })),
    },
    notification: undefined,
  };
}

import { checkComplianceAndCreateTasks } from '../mongoose/services/vehicleComplianceService.js';

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

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
      assert.equal(resolveCalls.length, 0);
    });

    it('asks for a high-priority EXPIRED reminder for an expired MOT', async () => {
      const past = daysFromNow(-10);
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{
          _id: 'v1',
          registrationNumber: 'AB12 CDE',
          make: 'Ford',
          model: 'Transit',
          motExpiryDate: past,
          availabilityStatus: 'Available',
        }],
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.equal(stats.created, 1);
      assert.equal(ensureCalls.length, 1);
      const call = ensureCalls[0];
      assert.equal(call.title, '[EXPIRED] MOT – AB12 CDE (Ford Transit)');
      assert.equal(call.systemKey, `vehicle:v1:motExpiryDate:${past.toISOString().slice(0, 10)}`);
      assert.equal(call.priority, 'high');
      assert.deepStrictEqual(call.legacyTitles, [
        '[EXPIRED] MOT – AB12 CDE (Ford Transit)',
        '[EXPIRING] MOT – AB12 CDE (Ford Transit)',
      ]);
      assert.ok(!/day\(s\)/.test(call.description), 'description has no day count that would go stale');
    });

    it('asks for a normal-priority EXPIRING reminder for insurance due soon', async () => {
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{
          _id: 'v2', registrationNumber: 'XY34 FGH', make: 'Toyota', model: 'Hilux',
          insuranceExpiryDate: daysFromNow(15),
        }],
      });

      await checkComplianceAndCreateTasks();
      assert.ok(ensureCalls[0].title.startsWith('[EXPIRING] Insurance'));
      assert.equal(ensureCalls[0].priority, 'normal');
    });

    it('passes every admin to the reminder', async () => {
      patchMdb({
        admins: [{ _id: 'admin1' }, { _id: 'admin2' }],
        vehicles: [{ _id: 'v3', registrationNumber: 'AA11 BBB', make: 'Ford', model: 'Focus', motExpiryDate: daysFromNow(-1) }],
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.deepStrictEqual(ensureCalls[0].userIds, ['admin1', 'admin2']);
      assert.equal(stats.created, 2);
    });

    it('closes reminders the scan no longer produces, keeping the current ones', async () => {
      const due = daysFromNow(20);
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{ _id: 'v4', registrationNumber: 'CC22 DDD', make: 'VW', model: 'Caddy', roadTaxExpiryDate: due }],
      });

      await checkComplianceAndCreateTasks();
      assert.equal(resolveCalls.length, 1);
      assert.equal(resolveCalls[0].prefix, 'vehicle:');
      assert.deepStrictEqual(resolveCalls[0].keys, [`vehicle:v4:roadTaxExpiryDate:${due.toISOString().slice(0, 10)}`]);
    });

    it('does not email or count already-handled reminders as new', async () => {
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{ _id: 'v5', registrationNumber: 'ZZ99 AAA', make: 'VW', model: 'Transporter', motExpiryDate: daysFromNow(-5) }],
        ensureResult: { created: 0, updated: 0, skipped: 1, handled: true },
      });

      const stats = await checkComplianceAndCreateTasks();
      assert.equal(stats.created, 0);
      assert.equal(stats.skipped, 1);
    });

    it('counts errors and closes nothing when a reminder fails', async () => {
      patchMdb({
        admins: [{ _id: 'admin1' }],
        vehicles: [{ _id: 'v6', registrationNumber: 'ERR 001', make: 'Error', model: 'Car', motExpiryDate: daysFromNow(-1) }],
      });
      taskService.ensureSystemTask = mock.fn(() => Promise.reject(new Error('fail')));

      logger.info('(intentional error log follows — task creation failure path)');
      const stats = await checkComplianceAndCreateTasks();

      assert.equal(stats.errors, 1);
      assert.equal(resolveCalls.length, 0);
    });
  });
});
