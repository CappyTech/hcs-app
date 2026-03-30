const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../services/loggerService');

/*
 * holidayAccrualService requires mdb at top-level (patch singleton)
 * and taxService at top-level (use as-is — pure date math).
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');

/* ── fake employeeHoliday model ───────────────────────────────────── */
let ehFindOneResult = null;
let ehUpdateOneCalls = [];
let ehConstructorCalls = [];

function makeEhDoc(overrides = {}) {
  return {
    _id: 'eh1',
    employeeId: 'emp1',
    entitlementType: 'days',
    entitlementDays: 28,
    entitlementHours: null,
    accrualMethod: 'fixed',
    accrualPercent: 12.07,
    accruedDays: 0,
    accruedHours: 0,
    takenDays: 0,
    takenHours: 0,
    save: mock.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function patchMdb({ ehDoc = null, employee = null } = {}) {
  ehFindOneResult = ehDoc;
  ehUpdateOneCalls = [];
  ehConstructorCalls = [];

  const EhModel = function (data) {
    ehConstructorCalls.push(data);
    const doc = makeEhDoc(data);
    return doc;
  };
  EhModel.findOne = mock.fn(() => Promise.resolve(ehFindOneResult));
  EhModel.updateOne = mock.fn((...args) => {
    ehUpdateOneCalls.push(args);
    return Promise.resolve();
  });

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    employeeHoliday: EhModel,
    employee: {
      findById: mock.fn(() => ({
        lean: mock.fn(() => Promise.resolve(employee)),
      })),
    },
  };
}

// Require AFTER mdb is available (it reads it at module load)
const { upsertEmployeeHolidayForDate, updateAccrualFromAttendance } =
  require('../mongoose/services/holidayAccrualService');

/* ── tests ─────────────────────────────────────────────────────────── */
describe('holidayAccrualService', () => {
  describe('upsertEmployeeHolidayForDate', () => {
    it('returns existing record when found', async () => {
      const existing = makeEhDoc();
      patchMdb({ ehDoc: existing });
      const result = await upsertEmployeeHolidayForDate('emp1', new Date('2025-06-01'));
      assert.equal(result, existing);
      assert.equal(existing.save.mock.callCount(), 0);
    });

    it('creates new record when none found', async () => {
      patchMdb({ ehDoc: null, employee: null });
      const result = await upsertEmployeeHolidayForDate('emp1', new Date('2025-06-01'));
      assert.ok(result);
      assert.equal(result.save.mock.callCount(), 1);
    });

    it('seeds from employee holiday policy when present', async () => {
      patchMdb({
        ehDoc: null,
        employee: {
          holidayPolicy: {
            entitlementType: 'hours',
            entitlementValue: 200,
            accrualMethod: 'per-hour',
            accrualPercent: 15,
            includesBankHolidays: false,
          },
        },
      });
      const result = await upsertEmployeeHolidayForDate('emp1', new Date('2025-06-01'));
      assert.ok(result);
      assert.equal(result.save.mock.callCount(), 1);
    });
  });

  describe('updateAccrualFromAttendance', () => {
    it('does nothing when employeeId is missing', async () => {
      patchMdb();
      await updateAccrualFromAttendance({});
      // No calls to findOne expected
    });

    it('tracks full-day holiday taken', async () => {
      const eh = makeEhDoc({ takenDays: 2, takenHours: 16 });
      patchMdb({
        ehDoc: eh,
        employee: { contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } },
      });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'holiday',
        hoursWorked: 0,
      });

      assert.equal(ehUpdateOneCalls.length, 1);
      const setArg = ehUpdateOneCalls[0][1].$set;
      assert.equal(setArg.takenDays, 3); // 2 + 1
      assert.equal(setArg.takenHours, 24); // 16 + 8
    });

    it('tracks partial-day holiday by hours', async () => {
      const eh = makeEhDoc({ takenDays: 0, takenHours: 0 });
      patchMdb({
        ehDoc: eh,
        employee: { contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } },
      });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'holiday',
        hoursWorked: 4,
      });

      assert.equal(ehUpdateOneCalls.length, 1);
      const setArg = ehUpdateOneCalls[0][1].$set;
      assert.equal(setArg.takenHours, 4);
      assert.equal(setArg.takenDays, 0.5); // 4 / 8
    });

    it('tracks leave type same as holiday', async () => {
      const eh = makeEhDoc({ takenDays: 1, takenHours: 8 });
      patchMdb({
        ehDoc: eh,
        employee: { contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } },
      });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'leave',
        hoursWorked: 0,
      });

      assert.equal(ehUpdateOneCalls.length, 1);
      assert.equal(ehUpdateOneCalls[0][1].$set.takenDays, 2);
    });

    it('per-hour accrual on work type', async () => {
      const eh = makeEhDoc({ accrualMethod: 'per-hour', accruedHours: 0, accruedDays: 0 });
      patchMdb({
        ehDoc: eh,
        employee: {
          holidayPolicy: { accrualMethod: 'per-hour', accrualPercent: 12.07 },
          contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 },
        },
      });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'work',
        hoursWorked: 8,
      });

      assert.equal(ehUpdateOneCalls.length, 1);
      const setArg = ehUpdateOneCalls[0][1].$set;
      // 8 * 0.1207 = 0.9656
      assert.ok(setArg.accruedHours > 0.96 && setArg.accruedHours < 0.97);
    });

    it('per-day accrual on work type', async () => {
      const eh = makeEhDoc({ accrualMethod: 'per-day', accruedDays: 0 });
      patchMdb({
        ehDoc: eh,
        employee: {
          holidayPolicy: { accrualMethod: 'per-day', accrualPercent: 12.07 },
          contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 },
        },
      });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'work',
        hoursWorked: 8,
      });

      assert.equal(ehUpdateOneCalls.length, 1);
      const setArg = ehUpdateOneCalls[0][1].$set;
      assert.ok(setArg.accruedDays > 0.12 && setArg.accruedDays < 0.13);
    });

    it('fixed accrual does not update', async () => {
      const eh = makeEhDoc({ accrualMethod: 'fixed' });
      patchMdb({
        ehDoc: eh,
        employee: { holidayPolicy: { accrualMethod: 'fixed' } },
      });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'work',
        hoursWorked: 8,
      });

      assert.equal(ehUpdateOneCalls.length, 0);
    });

    it('swallows errors without throwing', async () => {
      patchMdb();
      logger.info('(intentional warn log follows — holidayAccrualService DB error path)');
      mdb.INTERNAL.employeeHoliday.findOne = mock.fn(() => { throw new Error('DB fail'); });

      await updateAccrualFromAttendance({
        employeeId: 'emp1',
        date: new Date('2025-06-15'),
        type: 'work',
        hoursWorked: 8,
      });
      // Should not throw
    });
  });
});
