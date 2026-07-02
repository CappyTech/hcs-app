const mdb = require('./mongooseDatabaseService');
const taxService = require('../../services/taxService');

function toNumber(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') return Number(x) || 0;
  // Decimal128
  if (x && typeof x.toString === 'function') return Number(x.toString()) || 0;
  return 0;
}

async function upsertEmployeeHolidayForDate(employeeId, date) {
  const { taxYear } = taxService.calculateTaxYearAndMonth(date);
  const { start, end } = taxService.getTaxYearStartEnd(taxYear);

  let eh = await mdb.INTERNAL.employeeHoliday.findOne({ employeeId, periodStart: start, periodEnd: end });
  if (!eh) {
    // Seed employee policy defaults if present
    const employee = await mdb.INTERNAL.employee.findById(employeeId).lean();
    const policy = employee?.holidayPolicy || {};
    eh = new mdb.INTERNAL.employeeHoliday({
      employeeId,
      periodStart: start,
      periodEnd: end,
      entitlementType: policy.entitlementType || 'days',
      entitlementDays: policy.entitlementType === 'days' ? (policy.entitlementValue ?? 28) : null,
      entitlementHours: policy.entitlementType === 'hours' ? (policy.entitlementValue ?? 0) : null,
      accrualMethod: policy.accrualMethod || 'fixed',
      accrualPercent: policy.accrualPercent != null ? policy.accrualPercent : 12.07,
      bankHolidaysCounted: policy.includesBankHolidays !== undefined ? !!policy.includesBankHolidays : true,
      carryOverDays: 0,
      carryOverHours: 0,
      accruedDays: 0,
      accruedHours: 0,
      takenDays: 0,
      takenHours: 0,
    });
    await eh.save();
  }
  return eh;
}

async function updateAccrualFromAttendance(attendanceDoc) {
  try {
    const empId = attendanceDoc?.employeeId;
    if (!empId) return; // only applies to employees, not subcontractors

    const attendanceDate = attendanceDoc.date || new Date();
    const eh = await upsertEmployeeHolidayForDate(empId, attendanceDate);
    const employee = await mdb.INTERNAL.employee.findById(empId).lean();
    const policy = employee?.holidayPolicy || {};

    // ── Holiday / leave taken ──────────────────────────────────────────
    const isHolidayType = attendanceDoc.type === 'holiday' || attendanceDoc.type === 'leave';
    if (isHolidayType) {
      const hoursWorked = toNumber(attendanceDoc.hoursWorked);
      const takenUpdates = {};

      if (hoursWorked > 0) {
        // Partial-day holiday tracked by hours
        takenUpdates.takenHours = toNumber(eh.takenHours) + hoursWorked;
        // Also convert to days for the days tracker
        const hoursPerWeek = Number(employee?.contract?.hoursPerWeek) || 40;
        const daysPerWeek = Number(employee?.contract?.workingDaysPerWeek) || 5;
        const hoursPerDay = daysPerWeek > 0 ? (hoursPerWeek / daysPerWeek) : 8;
        if (hoursPerDay > 0) takenUpdates.takenDays = toNumber(eh.takenDays) + (hoursWorked / hoursPerDay);
      } else {
        // Full-day holiday
        takenUpdates.takenDays = toNumber(eh.takenDays) + 1;
        const hoursPerWeek = Number(employee?.contract?.hoursPerWeek) || 40;
        const daysPerWeek = Number(employee?.contract?.workingDaysPerWeek) || 5;
        const hoursPerDay = daysPerWeek > 0 ? (hoursPerWeek / daysPerWeek) : 8;
        takenUpdates.takenHours = toNumber(eh.takenHours) + hoursPerDay;
      }

      if (Object.keys(takenUpdates).length) {
        await mdb.INTERNAL.employeeHoliday.updateOne({ _id: eh._id }, { $set: takenUpdates });
      }
      return; // holiday/leave doesn't also accrue
    }

    // ── Work-type accrual ──────────────────────────────────────────────
    const method = policy.accrualMethod || eh.accrualMethod || 'fixed';
    const percent = (policy.accrualPercent != null ? policy.accrualPercent : eh.accrualPercent || 12.07) / 100;

    let deltaHours = 0;
    let deltaDays = 0;

    const isWorkType = attendanceDoc.type === 'work';
    const hoursWorked = toNumber(attendanceDoc.hoursWorked);

    if (method === 'per-hour') {
      deltaHours = (isWorkType ? hoursWorked : 0) * percent;
      if (eh.entitlementType === 'days' || eh.entitlementDays != null) {
        const hoursPerWeek = Number(employee?.contract?.hoursPerWeek) || 40;
        const daysPerWeek = Number(employee?.contract?.workingDaysPerWeek) || 5;
        const hoursPerDay = daysPerWeek > 0 ? (hoursPerWeek / daysPerWeek) : 8;
        if (hoursPerDay > 0) deltaDays = deltaHours / hoursPerDay;
      }
    } else if (method === 'per-day') {
      // accrues a fraction of a day per day worked
      const workedDay = isWorkType && (hoursWorked > 0 || attendanceDoc.dayRate != null);
      if (workedDay) {
        deltaDays = percent; // e.g., 12.07% of a day
        if (eh.entitlementType === 'hours' || eh.entitlementHours != null) {
          const hoursPerWeek = Number(employee?.contract?.hoursPerWeek) || 40;
          const daysPerWeek = Number(employee?.contract?.workingDaysPerWeek) || 5;
          const hoursPerDay = daysPerWeek > 0 ? (hoursPerWeek / daysPerWeek) : 8;
          deltaHours = hoursPerDay * percent;
        }
      }
    } else {
      // fixed: no per-attendance accrual update
      return;
    }

    const updates = {};
    if (deltaHours > 0) updates.accruedHours = (toNumber(eh.accruedHours) + deltaHours);
    if (deltaDays > 0) updates.accruedDays = (toNumber(eh.accruedDays) + deltaDays);

    if (Object.keys(updates).length) {
      await mdb.INTERNAL.employeeHoliday.updateOne({ _id: eh._id }, { $set: updates });
    }
  } catch (e) {
    // Swallow errors to avoid blocking attendance CRUD; log if logger available through mdb path
    try { require('../../services/loggerService').warn('holidayAccrualService error: ' + e.message); } catch {}
  }
}

module.exports = {
  updateAccrualFromAttendance,
  upsertEmployeeHolidayForDate,
};
