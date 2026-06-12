'use strict';

const mdb = require('./mongooseDatabaseService');
const taxService = require('../../services/taxService');
const logger = require('../../services/loggerService');

/**
 * Year-end holiday carry-over.
 *
 * For each active employee with a record for the previous holiday year
 * (tax-year window, 6 Apr – 5 Apr), roll unused entitlement into the current
 * year's `carryOverDays`/`carryOverHours`, capped by the employee's
 * `holidayPolicy.carryOverMaxDays`/`carryOverMaxHours` (default 0 = no
 * carry-over).
 *
 * Idempotent: a current-year record is only touched once
 * (`carryOverAppliedAt`) and never when carry-over was already set manually.
 * Safe to run daily — new holiday-year records pick up their carry-over the
 * first time the job sees them.
 */

function toNumber(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  const n = Number(typeof x.toString === 'function' ? x.toString() : x);
  return Number.isFinite(n) ? n : 0;
}

async function applyCarryOverOnce({ now = new Date() } = {}) {
  const stats = { processed: 0, applied: 0, skipped: 0, errors: 0 };

  const Employee = mdb.INTERNAL?.employee;
  const EmployeeHoliday = mdb.INTERNAL?.employeeHoliday;
  if (!Employee || !EmployeeHoliday) {
    logger.warn('[holidayCarryOverService] Required models not available — skipping.');
    return stats;
  }

  const { taxYear } = taxService.calculateTaxYearAndMonth(now);
  const current = taxService.getTaxYearStartEnd(taxYear);
  const previous = taxService.getTaxYearStartEnd(taxYear - 1);

  const employees = await Employee.find({ status: 'active' }).lean();

  for (const employee of employees) {
    stats.processed++;
    try {
      const prev = await EmployeeHoliday.findOne({
        employeeId: employee._id,
        periodStart: previous.start,
        periodEnd: previous.end,
      }).lean();
      if (!prev) {
        stats.skipped++;
        continue;
      }

      const holidayAccrualService = require('./holidayAccrualService');
      const curr = await holidayAccrualService.upsertEmployeeHolidayForDate(employee._id, now);

      // Already applied, or carry-over set manually — leave alone
      if (curr.carryOverAppliedAt || toNumber(curr.carryOverDays) > 0 || toNumber(curr.carryOverHours) > 0) {
        stats.skipped++;
        continue;
      }

      const policy = employee.holidayPolicy || {};
      const capDays = toNumber(policy.carryOverMaxDays);
      const capHours = toNumber(policy.carryOverMaxHours);

      const unusedDays = Math.max(0,
        toNumber(prev.entitlementDays) + toNumber(prev.carryOverDays) - toNumber(prev.takenDays));
      const unusedHours = Math.max(0,
        toNumber(prev.entitlementHours) + toNumber(prev.carryOverHours) - toNumber(prev.takenHours));

      const carryDays = Math.min(unusedDays, capDays);
      const carryHours = Math.min(unusedHours, capHours);

      await EmployeeHoliday.updateOne(
        { _id: curr._id },
        {
          $set: {
            carryOverDays: carryDays,
            carryOverHours: carryHours,
            carryOverAppliedAt: now,
          },
        },
      );
      if (carryDays > 0 || carryHours > 0) {
        stats.applied++;
        logger.info(`[holidayCarryOverService] ${employee.name}: carried over ${carryDays} day(s) / ${carryHours} hour(s) into ${current.start.toISOString().slice(0, 10)} year.`);
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.errors++;
      logger.error(`[holidayCarryOverService] Failed for employee ${employee.name || employee._id}: ${err.message}`);
    }
  }

  return stats;
}

module.exports = {
  applyCarryOverOnce,
};
