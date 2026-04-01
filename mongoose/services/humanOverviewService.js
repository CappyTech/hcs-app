'use strict';

const mdb = require('./mongooseDatabaseService');

/**
 * Fetch a full employee overview: summary stats, contract info,
 * current assignments, holiday balances, attendance, and more.
 *
 * @param {Object} [opts]
 * @param {number} [opts.contractEndDays=60] - How many days ahead to flag fixed-term contract ends
 * @param {number} [opts.recentDays=30]      - How many days back to count as "recently hired"
 * @returns {Promise<Object>}
 */
async function getHumanOverview({ contractEndDays = 60, recentDays = 30 } = {}) {
  const Employee = mdb.INTERNAL.employee;
  if (!Employee) throw new Error('Employee model not loaded');

  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + contractEndDays);
  const recentFrom = new Date(now);
  recentFrom.setDate(recentFrom.getDate() - recentDays);

  // ── All employees ──────────────────────────────────────────────────────────
  const allEmployees = await Employee.find({}).lean();
  const totalCount = allEmployees.length;

  // ── Status breakdown ───────────────────────────────────────────────────────
  const statusCounts = { active: 0, inactive: 0 };
  const typeCounts = { 'full-time': 0, 'part-time': 0 };
  for (const e of allEmployees) {
    if (e.status === 'active') statusCounts.active++;
    else statusCounts.inactive++;
    if (e.type === 'part-time') typeCounts['part-time']++;
    else typeCounts['full-time']++;
  }

  // ── Contract terms breakdown ───────────────────────────────────────────────
  const contractTermsCounts = {};
  for (const e of allEmployees) {
    const t = e.contract?.termsType || 'permanent';
    contractTermsCounts[t] = (contractTermsCounts[t] || 0) + 1;
  }

  // ── Fixed-term contracts ending soon ──────────────────────────────────────
  const endingSoon = allEmployees.filter(e => {
    if (e.contract?.termsType !== 'fixed-term') return false;
    const end = e.contract?.endDate ? new Date(e.contract.endDate) : null;
    return end && end >= now && end <= horizon;
  }).sort((a, b) => new Date(a.contract.endDate) - new Date(b.contract.endDate));

  // ── Fixed-term contracts already expired ──────────────────────────────────
  const contractExpired = allEmployees.filter(e => {
    if (e.contract?.termsType !== 'fixed-term') return false;
    const end = e.contract?.endDate ? new Date(e.contract.endDate) : null;
    return end && end < now;
  }).sort((a, b) => new Date(a.contract.endDate) - new Date(b.contract.endDate));

  // ── Recent hires ──────────────────────────────────────────────────────────
  const recentHires = allEmployees.filter(e => {
    const hired = e.hireDate ? new Date(e.hireDate) : null;
    return hired && hired >= recentFrom;
  }).sort((a, b) => new Date(b.hireDate) - new Date(a.hireDate));

  // ── IR35 employees ────────────────────────────────────────────────────────
  const ir35Employees = allEmployees.filter(e => e.ir35 === true);

  // ── Current assignment counts per employee (this week and future) ──────────
  let assignmentsByEmployee = {};
  try {
    const Assignment = mdb.INTERNAL.assignment;
    if (Assignment) {
      const activeAssignments = await Assignment.find({
        assignedEmployees: { $exists: true, $not: { $size: 0 } },
        status: { $in: ['Planned', 'In Progress'] },
        weekStart: { $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7) },
      }).lean();

      for (const a of activeAssignments) {
        for (const empId of (a.assignedEmployees || [])) {
          const key = empId.toString();
          assignmentsByEmployee[key] = (assignmentsByEmployee[key] || 0) + 1;
        }
      }
    }
  } catch (_) {
    // Non-fatal if assignment model unavailable
  }

  // Mark which employees are currently assigned
  const employeeMap = Object.fromEntries(allEmployees.map(e => [e._id.toString(), e]));
  const currentlyAssigned = allEmployees
    .filter(e => assignmentsByEmployee[e._id.toString()] > 0)
    .map(e => ({ ...e, _assignmentCount: assignmentsByEmployee[e._id.toString()] || 0 }));

  const unassigned = allEmployees
    .filter(e => e.status === 'active' && !assignmentsByEmployee[e._id.toString()]);

  // ── Holiday balances (current period) ─────────────────────────────────────
  let holidayBalances = [];
  let lowBalanceEmployees = [];
  try {
    const EmployeeHoliday = mdb.INTERNAL.employeeHoliday;
    if (EmployeeHoliday) {
      const currentPeriodHolidays = await EmployeeHoliday.find({
        periodStart: { $lte: now },
        periodEnd: { $gte: now },
      }).lean();

      // Build map: employeeId → holiday record
      for (const h of currentPeriodHolidays) {
        const emp = employeeMap[h.employeeId?.toString()];
        if (!emp) continue;

        const remaining = h.entitlementType === 'hours'
          ? (h.entitlementHours || 0) + (h.carryOverHours || 0) - (h.takenHours || 0)
          : (h.entitlementDays || 0) + (h.carryOverDays || 0) - (h.takenDays || 0);

        const balance = {
          employee: emp,
          entitlement: h.entitlementType === 'hours' ? h.entitlementHours : h.entitlementDays,
          carryOver: h.entitlementType === 'hours' ? h.carryOverHours : h.carryOverDays,
          taken: h.entitlementType === 'hours' ? h.takenHours : h.takenDays,
          remaining,
          type: h.entitlementType,
        };
        holidayBalances.push(balance);
        if (remaining <= 3) lowBalanceEmployees.push(balance);
      }
    }
  } catch (_) {
    // Non-fatal
  }

  // ── Recent attendance summary (last 7 days) ───────────────────────────────
  let attendanceSummary = { work: 0, sick: 0, holiday: 0, training: 0, off: 0, leave: 0 };
  let pendingAttendance = [];
  try {
    const Attendance = mdb.INTERNAL.attendance;
    if (Attendance) {
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const recentAttendance = await Attendance.find({
        date: { $gte: sevenDaysAgo },
        employeeId: { $ne: null },
      }).lean();

      for (const a of recentAttendance) {
        if (attendanceSummary[a.type] !== undefined) {
          attendanceSummary[a.type]++;
        }
      }

      pendingAttendance = await Attendance.find({
        status: 'pending',
        employeeId: { $ne: null },
      })
        .sort({ date: -1 })
        .limit(20)
        .lean();

      // Enrich with employee names
      const pendingEmpIds = [...new Set(pendingAttendance.map(a => a.employeeId?.toString()).filter(Boolean))];
      if (pendingEmpIds.length) {
        const pendingEmps = await Employee.find({ _id: { $in: pendingEmpIds } }).select('_id name uuid').lean();
        const pendingEmpMap = Object.fromEntries(pendingEmps.map(e => [e._id.toString(), e]));
        for (const a of pendingAttendance) {
          const e = pendingEmpMap[a.employeeId?.toString()];
          a._employeeName = e?.name || 'Unknown';
          a._employeeUuid = e?.uuid || null;
        }
      }
    }
  } catch (_) {
    // Non-fatal
  }

  // ── Vehicles assigned to employees ────────────────────────────────────────
  let employeeVehicles = [];
  try {
    const Vehicle = mdb.INTERNAL.vehicle;
    if (Vehicle) {
      const vehicles = await Vehicle.find({
        employeeId: { $ne: null },
        availabilityStatus: { $ne: 'Disposed' },
      }).lean();

      const vEmpIds = [...new Set(vehicles.map(v => v.employeeId?.toString()).filter(Boolean))];
      if (vEmpIds.length) {
        const vEmps = await Employee.find({ _id: { $in: vEmpIds } }).select('_id name uuid').lean();
        const vEmpMap = Object.fromEntries(vEmps.map(e => [e._id.toString(), e]));
        for (const v of vehicles) {
          const emp = vEmpMap[v.employeeId?.toString()];
          v._employeeName = emp?.name || 'Unknown';
          v._employeeUuid = emp?.uuid || null;
        }
      }
      employeeVehicles = vehicles;
    }
  } catch (_) {
    // Non-fatal
  }

  return {
    totalCount,
    statusCounts,
    typeCounts,
    contractTermsCounts,
    endingSoon,
    contractExpired,
    recentHires,
    ir35Employees,
    currentlyAssigned,
    unassigned,
    holidayBalances,
    lowBalanceEmployees,
    attendanceSummary,
    pendingAttendance,
    employeeVehicles,
    contractEndDays,
    recentDays,
  };
}

module.exports = { getHumanOverview };
