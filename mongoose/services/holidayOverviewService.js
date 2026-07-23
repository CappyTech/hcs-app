import mdb from './mongooseDatabaseService.js';

/**
 * Holiday Overview landing page data: a hub that pulls together the three
 * sides of holiday administration — accrual/entitlement (employeeHoliday),
 * the request → approval workflow (holidayRequest), and the holiday calendar
 * (government holidays + company holidays). The detailed CRUD lists live at
 * /employeeHolidays, /holidayRequests, /holidays and /holidayCustoms; this
 * page summarises them and links through.
 *
 * @param {Object} [opts]
 * @param {number} [opts.upcomingDays=60] - How many days ahead to list holidays
 * @param {number} [opts.lowBalanceThreshold=3] - Remaining days/hours at or below which a balance is flagged low
 * @returns {Promise<Object>}
 */
async function getHolidayOverview({ upcomingDays = 60, lowBalanceThreshold = 3 } = {}) {
  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + upcomingDays);

  const Employee = mdb.INTERNAL.employee;
  const EmployeeHoliday = mdb.INTERNAL.employeeHoliday;
  const HolidayRequest = mdb.INTERNAL.holidayRequest;
  const Holiday = mdb.INTERNAL.holiday;
  const HolidayCustom = mdb.INTERNAL.holidayCustom;

  // ── Holiday balances for the current period ────────────────────────────────
  let balances = [];
  let lowBalanceCount = 0;
  let totalRemainingDays = 0;
  if (EmployeeHoliday && Employee) {
    const currentPeriod = await EmployeeHoliday.find({
      periodStart: { $lte: now },
      periodEnd: { $gte: now },
    }).lean();

    const empIds = [...new Set(currentPeriod.map(h => h.employeeId?.toString()).filter(Boolean))];
    const emps = empIds.length
      ? await Employee.find({ _id: { $in: empIds } }).select('_id name uuid position status').lean()
      : [];
    const empMap = Object.fromEntries(emps.map(e => [e._id.toString(), e]));

    for (const h of currentPeriod) {
      const emp = empMap[h.employeeId?.toString()];
      if (!emp) continue;
      const isHours = h.entitlementType === 'hours';
      const entitlement = (isHours ? h.entitlementHours : h.entitlementDays) || 0;
      const carryOver = (isHours ? h.carryOverHours : h.carryOverDays) || 0;
      const taken = (isHours ? h.takenHours : h.takenDays) || 0;
      const remaining = entitlement + carryOver - taken;
      const low = remaining <= lowBalanceThreshold;
      if (low) lowBalanceCount++;
      if (!isHours) totalRemainingDays += remaining;
      balances.push({
        employeeName: emp.name,
        employeeUuid: emp.uuid,
        position: emp.position || '',
        uuid: h.uuid,
        type: h.entitlementType || 'days',
        entitlement,
        carryOver,
        taken,
        remaining,
        low,
      });
    }
    // Lowest remaining first so the records that need attention are at the top
    balances.sort((a, b) => a.remaining - b.remaining);
  }

  // ── Pending holiday requests (awaiting a decision) ─────────────────────────
  let pendingRequests = [];
  if (HolidayRequest && Employee) {
    const pending = await HolidayRequest.find({ status: 'pending' })
      .sort({ startDate: 1 })
      .limit(50)
      .lean();

    const reqEmpIds = [...new Set(pending.map(r => r.employeeId?.toString()).filter(Boolean))];
    const reqEmps = reqEmpIds.length
      ? await Employee.find({ _id: { $in: reqEmpIds } }).select('_id name uuid').lean()
      : [];
    const reqEmpMap = Object.fromEntries(reqEmps.map(e => [e._id.toString(), e]));

    pendingRequests = pending.map(r => {
      const emp = reqEmpMap[r.employeeId?.toString()];
      return {
        uuid: r.uuid,
        employeeName: emp?.name || 'Unknown employee',
        employeeUuid: emp?.uuid || null,
        startDate: r.startDate,
        endDate: r.endDate,
        daysRequested: r.daysRequested,
        leaveType: r.leaveType,
        reason: r.reason || '',
      };
    });
  }

  // ── Recently decided requests (for context) ────────────────────────────────
  let recentDecisions = [];
  if (HolidayRequest && Employee) {
    const decided = await HolidayRequest.find({ status: { $in: ['approved', 'rejected'] } })
      .sort({ reviewedAt: -1, updatedAt: -1 })
      .limit(8)
      .lean();
    const decEmpIds = [...new Set(decided.map(r => r.employeeId?.toString()).filter(Boolean))];
    const decEmps = decEmpIds.length
      ? await Employee.find({ _id: { $in: decEmpIds } }).select('_id name uuid').lean()
      : [];
    const decEmpMap = Object.fromEntries(decEmps.map(e => [e._id.toString(), e]));
    recentDecisions = decided.map(r => {
      const emp = decEmpMap[r.employeeId?.toString()];
      return {
        uuid: r.uuid,
        employeeName: emp?.name || 'Unknown employee',
        startDate: r.startDate,
        endDate: r.endDate,
        daysRequested: r.daysRequested,
        status: r.status,
        reviewedAt: r.reviewedAt,
      };
    });
  }

  // ── Upcoming holidays (government + company) ───────────────────────────────
  // Government holidays store `date` as a YYYY-MM-DD string; company holidays
  // (holidayCustom) store a real Date. Normalise both into one sorted list.
  const upcomingHolidays = [];
  const todayStr = now.toISOString().slice(0, 10);
  const horizonStr = horizon.toISOString().slice(0, 10);
  if (Holiday) {
    const govt = await Holiday.find({ date: { $gte: todayStr, $lte: horizonStr } })
      .sort({ date: 1 })
      .lean();
    for (const h of govt) {
      upcomingHolidays.push({
        title: h.title,
        date: new Date(`${h.date}T00:00:00`),
        division: h.division || '',
        source: 'Government',
      });
    }
  }
  if (HolidayCustom) {
    const custom = await HolidayCustom.find({ date: { $gte: now, $lte: horizon } })
      .sort({ date: 1 })
      .lean();
    for (const h of custom) {
      upcomingHolidays.push({
        title: h.title,
        date: h.date,
        division: '',
        source: 'Company',
      });
    }
  }
  upcomingHolidays.sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    upcomingDays,
    lowBalanceThreshold,
    // Summary
    employeesTracked: balances.length,
    pendingCount: pendingRequests.length,
    lowBalanceCount,
    totalRemainingDays: Math.round(totalRemainingDays * 10) / 10,
    // Panels
    balances,
    pendingRequests,
    recentDecisions,
    upcomingHolidays,
  };
}

export default { getHolidayOverview };
