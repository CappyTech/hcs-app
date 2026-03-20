const path = require("path");
const moment = require("moment-timezone");
const attendanceService = require("../services/attendanceServicesMongoose");
const mdb = require("../services/mongooseDatabaseService");
const logger = require("../../services/loggerService");
const { scopeQuery } = require("../../services/dataScopingService");

/**
 * Filter attendance records array to only those the user owns.
 * Admin/unrestricted roles get everything.
 */
async function filterAttendanceForUser(req, records) {
  if (!req.user || req.user.role === "admin") return records;
  const filter = await scopeQuery(req, "attendance", "r");
  if (!filter || Object.keys(filter).length === 0) return records;
  return records.filter((rec) => {
    return Object.entries(filter).every(([k, v]) => {
      const val = rec[k]?._id || rec[k]; // handle populated refs
      return val && String(val) === String(v);
    });
  });
}

exports.getDailyAttendance = async (req, res, next) => {
  const date = req.params.date || moment().format("YYYY-MM-DD");
  try {
    let attendance = await attendanceService.getAttendanceForDay(date);
    attendance = await filterAttendanceForUser(req, attendance);
    res.render(path.join("tailwindcss", "attendance", "daily"), {
      title: `Attendance for ${moment(date).format("DD MMMM YYYY")}`,
      moment,
      attendance,
      date,
    });
  } catch (err) {
    next(err);
  }
};

exports.getWeeklyAttendance = async (req, res, next) => {
  try {
    const yearParam = parseInt(req.params.year);
    const weekParam = parseInt(req.params.week);

    const {
      groupedAttendance,
      payrollWeekStart,
      endDate,
      previousYear,
      previousWeek,
      nextYear,
      nextWeek,
      employeeCount,
      subcontractorCount,
      totalEmployeePay,
      totalEmployeeHours,
      totalSubcontractorPay,
      totalSubcontractorDays,
      daysOfWeek,
      activeProjects,
      projectStatusFilter,
      taxWeekNumber,
      taxYear,
      pendingCount,
      approvedCount,
      rejectedCount,
      typeBreakdown,
      dailyHeadcount,
    } = await attendanceService.getAttendanceForWeek(yearParam, weekParam);

    const isManagementView = req.isManagementView === true;

    // ── Scope weekly data to own records for non-admin users ──
    let scopedGrouped = groupedAttendance;
    if (req.user && req.user.role !== "admin") {
      const filter = await scopeQuery(req, "attendance", "r");
      if (filter && Object.keys(filter).length > 0) {
        // groupedAttendance is keyed by person uuid; each value has entityId (the ObjectId)
        const filterField = Object.keys(filter)[0]; // e.g. 'employeeId' or 'subcontractorId'
        const filterValue = String(filter[filterField]);
        scopedGrouped = {};
        for (const [uuid, data] of Object.entries(groupedAttendance)) {
          const entityId = data.entityId || data._id;
          if (entityId && String(entityId) === filterValue) {
            scopedGrouped[uuid] = data;
          }
        }
      }
    }

    // Strip payroll-sensitive data for non-admin/accountant in standard view too
    const stripPay =
      req.user && !["admin", "accountant"].includes(req.user.role);

    const employeeEntries = Object.entries(scopedGrouped)
      .filter(([_, v]) => v.type === "employee")
      .map(([uuid, v]) => [
        uuid,
        isManagementView || stripPay ? stripPayroll(v) : v,
      ]);

    const subcontractorEntries = Object.entries(scopedGrouped)
      .filter(([_, v]) => v.type === "subcontractor")
      .map(([uuid, v]) => [
        uuid,
        isManagementView || stripPay ? stripPayroll(v) : v,
      ]);

    const viewFile = isManagementView ? "weeklyManagement" : "weeklyAdmin";
    res.render(path.join("tailwindcss", "attendance", "weekly"), {
      title: `Tax Week ${taxWeekNumber} — ${payrollWeekStart.format("YYYY")}`,
      moment,
      groupedAttendance: scopedGrouped,
      startDate: payrollWeekStart.format("YYYY-MM-DD"),
      endDate: endDate.format("YYYY-MM-DD"),
      previousYear,
      previousWeek,
      nextYear,
      nextWeek,
      employeeCount,
      subcontractorCount,
      totalEmployeePay: isManagementView ? null : totalEmployeePay,
      totalEmployeeHours: isManagementView ? null : totalEmployeeHours,
      totalSubcontractorPay: isManagementView ? null : totalSubcontractorPay,
      totalSubcontractorDays: isManagementView ? null : totalSubcontractorDays,
      daysOfWeek,
      activeProjects,
      projectStatusFilter,
      employeeEntries,
      subcontractorEntries,
      isManagementView,
      taxWeekNumber,
      taxYear,
      pendingCount,
      approvedCount,
      rejectedCount,
      typeBreakdown,
      dailyHeadcount,
    });
  } catch (err) {
    next(err);
  }
};

function stripPayroll(record) {
  const clone = { ...record };
  delete clone.totalPay;
  delete clone.hoursWorked;
  delete clone.payRate;
  delete clone.totalHours;
  delete clone.daysWorked;
  delete clone.cisDeductions;
  return clone;
}

exports.approveAttendance = async (req, res, next) => {
  try {
    const updated = await mdb.INTERNAL.attendance.findOneAndUpdate(
      { uuid: req.params.uuid, status: "pending" },
      { status: "approved" },
      { new: true },
    );
    if (!updated) {
      logger.warn(
        `Approve failed: attendance ${req.params.uuid} not found or not pending`,
      );
      return res.status(404).redirect("back");
    }
    // Trigger holiday accrual now that it's approved
    const holidayAccrualService = require("../services/holidayAccrualService");
    await holidayAccrualService.updateAccrualFromAttendance(updated);
    logger.info(`✅ Attendance ${req.params.uuid} approved`);
    res.redirect("back");
  } catch (err) {
    logger.error(`❌ Error approving attendance: ${err.message}`);
    next(err);
  }
};

exports.rejectAttendance = async (req, res, next) => {
  try {
    const updated = await mdb.INTERNAL.attendance.findOneAndUpdate(
      { uuid: req.params.uuid, status: "pending" },
      { status: "rejected" },
      { new: true },
    );
    if (!updated) {
      logger.warn(
        `Reject failed: attendance ${req.params.uuid} not found or not pending`,
      );
      return res.status(404).redirect("back");
    }
    logger.info(`❌ Attendance ${req.params.uuid} rejected`);
    res.redirect("back");
  } catch (err) {
    logger.error(`❌ Error rejecting attendance: ${err.message}`);
    next(err);
  }
};

exports.bulkApproveAttendance = async (req, res, next) => {
  try {
    const { weekStart, weekEnd } = req.body;
    if (!weekStart || !weekEnd) {
      logger.warn("Bulk approve: missing weekStart or weekEnd");
      return res.status(400).redirect("back");
    }

    const start = moment(weekStart).startOf("day").toDate();
    const end = moment(weekEnd).endOf("day").toDate();

    const result = await mdb.INTERNAL.attendance.updateMany(
      { date: { $gte: start, $lte: end }, status: "pending" },
      { status: "approved" },
    );

    // Trigger holiday accrual for each approved record
    if (result.modifiedCount > 0) {
      const holidayAccrualService = require("../services/holidayAccrualService");
      const approvedRecords = await mdb.INTERNAL.attendance.find({
        date: { $gte: start, $lte: end },
        status: "approved",
      });
      for (const record of approvedRecords) {
        try {
          await holidayAccrualService.updateAccrualFromAttendance(record);
        } catch (accrualErr) {
          logger.warn(
            `Holiday accrual update failed for ${record.uuid}: ${accrualErr.message}`,
          );
        }
      }
    }

    logger.info(
      `✅ Bulk approved ${result.modifiedCount} attendance records for ${weekStart} to ${weekEnd}`,
    );
    res.redirect("back");
  } catch (err) {
    logger.error(`❌ Error bulk approving attendance: ${err.message}`);
    next(err);
  }
};

// ── Self-service attendance submission ──────────────────────────────────

exports.renderSubmitAttendance = async (req, res, next) => {
  try {
    const role = req.user.role;
    const isEmployee = role === "employee";

    // Fetch reference data for the form
    const [projects, locations] = await Promise.all([
      mdb.REST?.project
        ?.find({ $or: [{ Status: 0 }, { Status: 2 }] })
        .select("uuid Name Number Status")
        .lean() || [],
      mdb.INTERNAL?.location?.find({}).select("uuid name").lean() || [],
    ]);

    // Get the user's linked entity name for display
    let entityName = req.user.username;
    if (isEmployee && req.user.employeeId) {
      const emp = await mdb.INTERNAL.employee
        .findById(req.user.employeeId)
        .select("name")
        .lean();
      if (emp) entityName = emp.name;
    } else if (!isEmployee && req.user.subcontractorId) {
      const sub = await mdb.REST.supplier
        .findById(req.user.subcontractorId)
        .select("Name")
        .lean();
      if (sub) entityName = sub.Name;
    }

    res.render(path.join("tailwindcss", "attendance", "submit"), {
      title: "Submit Attendance",
      moment,
      projects,
      locations,
      entityName,
      isEmployee,
      today: moment().format("YYYY-MM-DD"),
    });
  } catch (err) {
    next(err);
  }
};

exports.submitAttendance = async (req, res, next) => {
  try {
    const role = req.user.role;
    const isEmployee = role === "employee";

    // Build attendance record — force entity from logged-in user
    const data = {
      date: req.body.date,
      type: req.body.type || "work",
      status: "pending", // always pending, admin must approve
      notes: req.body.notes || "",
    };

    // Force ownership from the logged-in user's linked entity
    if (isEmployee) {
      if (!req.user.employeeId) {
        req.flash("error", "Your account is not linked to an employee record.");
        return res.redirect("/attendance/submit");
      }
      data.employeeId = req.user.employeeId;
    } else {
      if (!req.user.subcontractorId) {
        req.flash(
          "error",
          "Your account is not linked to a subcontractor record.",
        );
        return res.redirect("/attendance/submit");
      }
      data.subcontractorId = req.user.subcontractorId;
    }

    // Optional references
    if (req.body.projectId) data.projectId = req.body.projectId;
    if (req.body.locationId) data.locationId = req.body.locationId;

    // Hours/rate (employees only — subcontractors use dayRate set by admin)
    if (isEmployee && req.body.hoursWorked) {
      data.hoursWorked = Number(req.body.hoursWorked);
    }
    if (req.body.dayRate) {
      data.dayRate = Number(req.body.dayRate);
    }

    const record = new mdb.INTERNAL.attendance(data);
    await record.save();

    logger.info(
      `📝 Self-service attendance submitted by ${req.user.username} (${role}): ${record.uuid}`,
    );
    req.flash("success", "Attendance submitted for approval.");
    res.redirect("/daily/" + moment(data.date).format("YYYY-MM-DD"));
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key — attendance already exists for this date/location/project
      req.flash(
        "error",
        "You already have an attendance record for this date/location/project combination.",
      );
      return res.redirect("/attendance/submit");
    }
    logger.error(`❌ Self-service attendance error: ${err.message}`);
    next(err);
  }
};
