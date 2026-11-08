import path from 'path';
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import attendanceService from '../services/attendanceService.js';

/**
 * Strict "YYYY-MM-DD" parser returning a server-local-midnight Date, or null.
 * Rejects impossible dates (e.g. 2025-02-30), matching the old
 * moment(date, "YYYY-MM-DD", true).isValid() behaviour.
 */
function parseYMDLocal(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import { scopeQuery, matchesFilter } from '../../services/dataScopingService.js';
import rbac from '../config/rolePermissionsConfig.js';
import holidayAccrualService from '../services/holidayAccrualService.js';
import approval from '../services/attendanceApprovalService.js';
import __paperlessUpdateService from '../services/paperless/paperlessUpdateService.js';
import __paperlessClient from '../services/paperless/paperlessClient.js';
import mongoose from 'mongoose';

/**
 * Filter attendance records array to only those the user owns.
 * Admin/unrestricted roles get everything.
 */
async function filterAttendanceForUser(req, records) {
  if (!req.user || req.user.role === "admin") return records;
  const filter = await scopeQuery(req, "attendance", "r");
  // scopeQuery draws a distinction this used to collapse: `null` means the
  // role may not read this model at all, `{}` means it may read all of it.
  // Treating both as "return everything" made a denial indistinguishable from
  // unrestricted access. Latent until now — every role that could reach this
  // route already held an attendance grant — but it would have become live
  // the moment one that did not was let in.
  if (filter === null) return [];
  if (Object.keys(filter).length === 0) return records;
  // Own records and/or the viewer's sites (populated refs compare by _id)
  return records.filter((rec) => matchesFilter(rec, filter));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The "record a day" form on /daily, for whoever can record attendance:
 * admin, accountant, or Site Ops edit (a Supervisor or Site Manager gets
 * only their own sites). People offered are those assigned to the listed
 * contracts in the week holding `date`. null when the viewer can't record.
 */
async function recordFormFor(req, date) {
  const user = req.user;
  if (!user) return null;
  const canRecord = ["admin", "accountant"].includes(user.role)
    || rbac.hasGroup(user, "siteOps", "edit", { project: true });
  if (!canRecord) return null;
  const day = parseYMDLocal(date);
  if (!day) return null;
  const scope = await approval.writeScopeFor(req);
  const contracts = await mdb.INTERNAL.contract
    .find(scope === null ? { status: { $ne: "Completed" } } : { _id: { $in: scope.contractIds } })
    .select("_id title").sort({ title: 1 }).lean();
  const people = new Map();
  if (contracts.length) {
    const assignments = await mdb.INTERNAL.assignment
      .find({
        contractId: { $in: contracts.map((c) => c._id) },
        weekStart: { $gt: new Date(day.getTime() - 7 * DAY_MS), $lte: new Date(day.getTime() + DAY_MS - 1) },
      })
      .populate("assignedEmployees", "name")
      .populate("assignedSubcontractors", "Name name")
      .lean();
    for (const a of assignments) {
      for (const e of a.assignedEmployees || []) {
        if (e?._id) people.set(`e:${e._id}`, { value: `e:${e._id}`, label: e.name || "Employee", contractId: String(a.contractId) });
      }
      for (const s of a.assignedSubcontractors || []) {
        if (s?._id) people.set(`s:${s._id}`, { value: `s:${s._id}`, label: s.Name || s.name || "Subcontractor", contractId: String(a.contractId) });
      }
    }
  }
  return {
    contracts,
    people: [...people.values()].sort((a, b) => a.label.localeCompare(b.label)),
    sitesOnly: scope !== null,
  };
}

export const getDailyAttendance = async (req, res, next) => {
  const date = req.params.date || format(new Date(), "yyyy-MM-dd");
  try {
    let attendance = await attendanceService.getAttendanceForDay(date);
    attendance = await filterAttendanceForUser(req, attendance);
    const ctx = await approval.contextFor(req, attendance);
    res.render(path.join("tailwindcss", "attendance", "daily"), {
      title: `Attendance for ${format(new Date(date), "dd MMMM yyyy")}`,
      attendance,
      date,
      approvalActions: approval.actionsFor(ctx, attendance),
      recordForm: await recordFormFor(req, date),
      // Site Managers and Supervisors reach /inductions/record and
      // /rams/brief from here:
      // their site-only access doesn't open the Health & Safety overviews.
      canRecordInduction: !!req.user && (req.user.role === "admin"
        || rbac.hasGroup(req.user, "healthSafety", "edit", { project: true })),
    });
  } catch (err) {
    next(err);
  }
};

const RECORD_TYPES = ["work", "training", "sick", "holiday", "off", "leave"];

/**
 * POST /daily/:date/record — record one person's day on a contract, from
 * the form on /daily. A Supervisor or Site Manager may record only on
 * contracts that name them; the record starts pending.
 */
export const recordDay = async (req, res, next) => {
  const date = req.params.date;
  const back = `/daily/${encodeURIComponent(date || "")}`;
  const fail = (msg) => { req.flash("error", msg); return res.redirect(back); };
  try {
    const day = parseYMDLocal(date);
    if (!day) return fail("Invalid date.");
    const { person, contractId, type = "work", hoursWorked, notes } = req.body;
    const [kind, personId] = String(person || "").split(":");
    if (!["e", "s"].includes(kind) || !mongoose.Types.ObjectId.isValid(personId)) return fail("Choose who worked.");
    if (!RECORD_TYPES.includes(type)) return fail("Invalid type.");
    if (!mongoose.Types.ObjectId.isValid(contractId)) return fail("Choose a contract.");

    const scope = await approval.writeScopeFor(req);
    if (!approval.contractInScope(scope, contractId)) return fail("That contract isn't one of your sites.");
    const contract = await mdb.INTERNAL.contract.findById(contractId).select("_id projectId locationId status").lean();
    if (!contract) return fail("Contract not found.");

    const data = { date: day, type, status: "pending", contractId: contract._id };
    if (contract.projectId) data.projectId = contract.projectId;
    if (contract.locationId) data.locationId = contract.locationId;
    if (kind === "e") data.employeeId = personId; else data.subcontractorId = personId;
    if (hoursWorked !== undefined && hoursWorked !== "") {
      const h = Number(hoursWorked);
      if (!Number.isFinite(h) || h < 0 || h > 24) return fail("Hours must be between 0 and 24.");
      data.hoursWorked = h;
    }
    if (typeof notes === "string" && notes.trim()) data.notes = notes.trim().slice(0, 2000);

    if (req.user?.role !== "admin") {
      const lockedRun = await attendanceService.getLockedRunForDate(day);
      if (lockedRun) return fail(`This date falls in a ${lockedRun.status} payroll period and can no longer be edited.`);
    }

    await new mdb.INTERNAL.attendance(data).save();
    logger.info(`[attendanceController] Recorded attendance on ${date} by ${req.user?._id}`);
    req.flash("success", "Day recorded. It's pending until the week is approved.");
    return res.redirect(back);
  } catch (err) {
    if (err.code === 11000) return fail("That person already has a record on this day for this site.");
    if (err.name === "ValidationError" || /Attendance/.test(err.message || "")) return fail(err.message);
    next(err);
  }
};

export const getWeeklyAttendance = async (req, res, next) => {
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
      activeContracts,
      projectStatusFilter,
      taxWeekNumber,
      taxYear,
      pendingCount,
      siteApprovedCount,
      approvedCount,
      rejectedCount,
      typeBreakdown,
      dailyHeadcount,
      allEmployees,
      allSubcontractors,
      allSuppliersForAssignment,
      contractsForWeek,
      vehicles,
      vehicleDeploymentsByVehicleDate,
    } = await attendanceService.getAttendanceForWeek(yearParam, weekParam);

    const isManagementView = req.isManagementView === true;

    // ── Scope weekly data to own records for non-admin users ──
    let scopedGrouped = groupedAttendance;
    if (req.user && req.user.role !== "admin") {
      // The weekly view groups by person and can't filter per site, so it
      // keeps own-records scoping only (project-scoped roles don't reach it).
      const filter = await scopeQuery(req, "attendance", "r", { project: false });
      // Same null-means-denied distinction as filterAttendanceForUser above.
      if (filter === null) {
        scopedGrouped = {};
      } else if (Object.keys(filter).length > 0) {
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

    // Strip payroll-sensitive data unless the viewer may see values
    // (admin, accountant, or a job role that sees money).
    const stripPay = !!req.user && !rbac.canSeeValues(req.user);

    // ── Filter purchase events by view type ──
    // Management view: show only paid events (actual cash flow)
    // Payroll view: show due events; fall back to paid if no due event for that purchase
    const keepStatus = isManagementView ? "paid" : "due";
    const filterPurchaseEvents = (person) => {
      const clone = { ...person, dailyRecords: {} };
      let recalcPay = 0;

      // Collect which purchase UUIDs have a 'due' event (for payroll fallback logic)
      const hasDueEvent = new Set();
      if (!isManagementView) {
        for (const recs of Object.values(person.dailyRecords)) {
          for (const [rId, r] of Object.entries(recs)) {
            if (rId.startsWith("purchase-") && r.paymentStatus === "due") {
              hasDueEvent.add(r.purchaseUuid);
            }
          }
        }
      }

      for (const [day, recs] of Object.entries(person.dailyRecords)) {
        const filtered = {};
        for (const [rId, r] of Object.entries(recs)) {
          if (!rId.startsWith("purchase-")) {
            // Non-purchase records pass through unchanged
            filtered[rId] = r;
            recalcPay += r.weeklyPay || 0;
          } else if (r.paymentStatus === keepStatus) {
            filtered[rId] = r;
            recalcPay += r.weeklyPay || 0;
          } else if (!isManagementView && r.paymentStatus === "paid" && !hasDueEvent.has(r.purchaseUuid)) {
            // Payroll fallback: no DueDate for this purchase, show paid event instead
            filtered[rId] = r;
            recalcPay += r.weeklyPay || 0;
          }
        }
        if (Object.keys(filtered).length > 0) {
          clone.dailyRecords[day] = filtered;
        }
      }
      clone.weeklyPay = recalcPay;
      return clone;
    };

    const employeeEntries = Object.entries(scopedGrouped)
      .filter(([_, v]) => v.type === "employee")
      .map(([uuid, v]) => [
        uuid,
        isManagementView || stripPay ? stripPayroll(v) : v,
      ]);

    const subcontractorEntries = Object.entries(scopedGrouped)
      .filter(([_, v]) => v.type === "subcontractor")
      .map(([uuid, v]) => {
        const filtered = filterPurchaseEvents(v);
        return [uuid, isManagementView || stripPay ? stripPayroll(filtered) : filtered];
      });

    // Recalculate subcontractor totals from the filtered entries
    const filteredSubPay = subcontractorEntries.reduce((sum, [_, v]) => sum + (v.weeklyPay || 0), 0);
    const filteredSubDays = subcontractorEntries.reduce((sum, [_, v]) => sum + Object.keys(v.dailyRecords).length, 0);

    // ── Fetch Paperless statements with linked purchases ──
    // payrollWeekStart/endDate are London-midnight Date instants; the service
    // normalises to London day boundaries internally.
    const statements = await attendanceService.fetchStatementsForWeek(
      payrollWeekStart,
      endDate
    );

    // Map purchaseUuid → statement paperlessId so weeklyTable can link due events
    const purchaseStatementMap = {};
    for (const entry of statements) {
      const pid = entry.statement?.paperlessId;
      if (!pid) continue;
      for (const p of entry.purchases || []) {
        if (p.uuid) purchaseStatementMap[p.uuid] = pid;
      }
    }

    // ── Management-only: holiday balances + fleet compliance ──────────────
    let holidayBalanceMap = {};
    let fleetCompliance = [];
    if (isManagementView) {
      const today = new Date();

      // Collect employee Mongo ObjectIds from the filtered entries
      const empMongoIds = employeeEntries
        .map(([, v]) => v.employeeMongoId)
        .filter(Boolean);

      // Holiday balances: find active period for each employee
      const holidayRecords = empMongoIds.length
        ? await mdb.INTERNAL.employeeHoliday
            .find({
              employeeId: { $in: empMongoIds },
              periodStart: { $lte: today },
              periodEnd: { $gte: today },
            })
            .lean()
        : [];

      holidayBalanceMap = holidayRecords.reduce((map, h) => {
        const entitlement =
          h.entitlementDays != null ? h.entitlementDays : (h.accruedDays || 0);
        const carryOver = h.carryOverDays || 0;
        const taken = h.takenDays || 0;
        map[String(h.employeeId)] = {
          remaining: Math.max(0, entitlement + carryOver - taken),
          periodEnd: h.periodEnd,
        };
        return map;
      }, {});

      // Fleet compliance — active (non-disposed) vehicles only
      fleetCompliance = await mdb.INTERNAL.vehicle
        .find({ availabilityStatus: { $ne: 'Disposed' } })
        .select(
          "registrationNumber make model bodyType roadTaxExpiryDate motExpiryDate " +
          "insuranceExpiryDate insuranceProvider breakdownProvider breakdownExpiryDate ownershipStatus"
        )
        .lean();
    }

    // ── Locations for inline cell editor ──────────────────────────────────
    const locations = await mdb.INTERNAL.location
      .find({})
      .select("_id uuid name")
      .sort({ name: 1 })
      .lean();

    const viewFile = isManagementView ? "weeklyManagement" : "weeklyAdmin";
    // REVERT: change 'weekly-excel' back to 'weekly' to disable inline cell editing
    res.render(path.join("tailwindcss", "attendance", "weekly-excel"), {
      title: `Tax Week ${taxWeekNumber} — ${formatInTimeZone(payrollWeekStart, "Europe/London", "yyyy")}`,
      groupedAttendance: scopedGrouped,
      startDate: formatInTimeZone(payrollWeekStart, "Europe/London", "yyyy-MM-dd"),
      endDate: formatInTimeZone(endDate, "Europe/London", "yyyy-MM-dd"),
      previousYear,
      previousWeek,
      nextYear,
      nextWeek,
      employeeCount,
      subcontractorCount,
      totalEmployeePay: isManagementView ? null : totalEmployeePay,
      totalEmployeeHours: isManagementView ? null : totalEmployeeHours,
      totalSubcontractorPay: isManagementView ? null : filteredSubPay,
      totalSubcontractorDays: isManagementView ? null : filteredSubDays,
      daysOfWeek,
      activeProjects,
      activeContracts,
      projectStatusFilter,
      employeeEntries,
      subcontractorEntries,
      isManagementView,
      taxWeekNumber,
      taxYear,
      pendingCount,
      siteApprovedCount,
      approvedCount,
      rejectedCount,
      typeBreakdown,
      dailyHeadcount,
      statements,
      purchaseStatementMap,
      holidayBalanceMap,
      fleetCompliance,
      locations,
      allEmployees: allEmployees.map(e => ({ _id: e._id, uuid: e.uuid, name: e.name })),
      allSubcontractors: allSubcontractors.map(s => ({ _id: s._id, uuid: s.uuid, Name: s.Name })),
      contractsForWeek,
      vehicles,
      vehicleDeploymentsByVehicleDate,
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

// Two-stage approval: attendanceApprovalService decides what each viewer may
// move (site step, final step, or admin's one step).
export const approveAttendance = async (req, res, next) => {
  try {
    const result = await approval.approveOne(req, req.params.uuid);
    if (!result.ok) {
      logger.warn(`[attendanceController] Approve refused for ${req.params.uuid}: ${result.reason}`);
      req.flash("error", result.reason);
      return res.redirect("back");
    }
    // Holiday accrual only once it's finally approved
    if (result.next === "approved") {
      await holidayAccrualService.updateAccrualFromAttendance(result.record);
    }
    logger.info(`[attendanceController] Attendance ${req.params.uuid} ${result.next}`);
    req.flash("success", result.next === "approved" ? "Approved." : "Approved for the site. A contracts manager gives the final approval.");
    res.redirect("back");
  } catch (err) {
    logger.error(`[attendanceController] Error approving attendance: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

export const rejectAttendance = async (req, res, next) => {
  try {
    const result = await approval.rejectOne(req, req.params.uuid, req.body?.reason);
    if (!result.ok) {
      logger.warn(`[attendanceController] Reject refused for ${req.params.uuid}: ${result.reason}`);
      req.flash("error", result.reason);
      return res.redirect("back");
    }
    logger.info(`[attendanceController] Attendance ${req.params.uuid} rejected`);
    req.flash("success", "Rejected.");
    res.redirect("back");
  } catch (err) {
    logger.error(`[attendanceController] Error rejecting attendance: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

export const bulkApproveAttendance = async (req, res, next) => {
  try {
    const { weekStart, weekEnd } = req.body;
    if (!weekStart || !weekEnd) {
      logger.warn('[attendanceController] Bulk approve: missing weekStart or weekEnd');
      return res.status(400).redirect("back");
    }

    const start = new Date(weekStart);
    start.setHours(0, 0, 0, 0);
    const end = new Date(weekEnd);
    end.setHours(23, 59, 59, 999);

    // Each record moves as far as this viewer may take it
    const { counts, approved } = await approval.approveRange(req, start, end);

    // Holiday accrual for each record that reached the final step
    for (const record of approved) {
      try {
        await holidayAccrualService.updateAccrualFromAttendance(record);
      } catch (accrualErr) {
        logger.warn(`[attendanceController] Holiday accrual update failed for ${record.uuid}: ${accrualErr.message}`);
      }
    }

    const parts = [];
    if (counts.approved) parts.push(`${counts.approved} approved`);
    if (counts["site-approved"]) parts.push(`${counts["site-approved"]} approved for the site`);
    if (counts.waiting) parts.push(`${counts.waiting} waiting for another approver`);
    req.flash("success", parts.length ? `${parts.join(", ")}.` : "Nothing for you to approve this week.");
    logger.info(`[attendanceController] Bulk approve ${weekStart} to ${weekEnd}: ${JSON.stringify(counts)}`);
    res.redirect("back");
  } catch (err) {
    logger.error(`[attendanceController] Error bulk approving attendance: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

// ── Self-service attendance submission ──────────────────────────────────

export const renderSubmitAttendance = async (req, res, next) => {
  try {
    const role = req.user.role;
    const isEmployee = role === "employee";

    // Fetch reference data for the form
    const [projects, locations] = await Promise.all([
      mdb.REST?.project
        ?.find({ Status: { $nin: ['Archived', 'Completed'] } })
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
      projects,
      locations,
      entityName,
      isEmployee,
      today: format(new Date(), "yyyy-MM-dd"),
    });
  } catch (err) {
    next(err);
  }
};

export const submitAttendance = async (req, res, next) => {
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

    // Payroll lock: reject submissions for dates already in a locked/submitted run
    const lockedRun = await attendanceService.getLockedRunForDate(data.date);
    if (lockedRun) {
      req.flash(
        "error",
        `Attendance for this date can no longer be submitted — the payroll period ` +
          `${format(new Date(lockedRun.periodStart), "d MMM")} – ${format(new Date(lockedRun.periodEnd), "d MMM yyyy")} ` +
          `has been ${lockedRun.status}. Contact an administrator if a correction is needed.`,
      );
      return res.redirect("/attendance/submit");
    }

    const record = new mdb.INTERNAL.attendance(data);
    await record.save();

    logger.info(`[attendanceController] Self-service attendance submitted by ${req.user.username} (${role}): ${record.uuid}`);
    req.flash("success", "Attendance submitted for approval.");
    res.redirect("/daily/" + format(new Date(data.date), "yyyy-MM-dd"));
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key — attendance already exists for this date/location/project
      req.flash(
        "error",
        "You already have an attendance record for this date/location/project combination.",
      );
      return res.redirect("/attendance/submit");
    }
    logger.error(`[attendanceController] Self-service attendance error: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

// ── Statement purchase management ──────────────────────────────────────

/**
 * Helper: read "Invoice Number" from an OcrDocument, return as array of trimmed strings.
 */
function parseStatementInvoiceNumbers(doc) {
  const field = (doc.customFields || []).find(
    (cf) => cf.fieldName === "Invoice Number",
  );
  const raw = field ? String(field.value || "") : "";
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Helper: persist updated invoice numbers to MongoDB OcrDocument and sync back to Paperless.
 */
async function saveStatementInvoiceNumbers(paperlessId, numbers) {
  const csvValue = numbers.join(", ");

  // Update the customFields array in MongoDB
  await mdb.PAPERLESS.OcrDocument.updateOne(
    { paperlessId, "customFields.fieldName": "Invoice Number" },
    { $set: { "customFields.$.value": csvValue } },
  );

  // Best-effort sync back to Paperless-ngx
  try {
    const { updatePaperlessWithKashFlowInfo } = __paperlessUpdateService;
    const { makeClient } = __paperlessClient;
    const api = makeClient();
    await api.updateDocumentCustomFields(paperlessId, {
      "Invoice Number": csvValue,
    });
  } catch (err) {
    logger.warn(`[attendanceController] Sync to Paperless failed for doc ${paperlessId}: ${err.message}`);
  }
}

/**
 * POST /statement/:paperlessId/add-purchase
 * Adds a purchase number to the statement's "Invoice Number" custom field.
 */
export const addStatementPurchase = async (req, res, next) => {
  try {
    const paperlessId = parseInt(req.params.paperlessId, 10);
    const purchaseNumber = String(req.body.purchaseNumber || "").trim();
    if (!purchaseNumber) {
      req.flash("error", "Purchase number is required.");
      return res.redirect("back");
    }

    // Verify the purchase exists in REST
    const purchase = await mdb.REST.purchase
      .findOne({ Number: purchaseNumber })
      .select("Number")
      .lean();
    if (!purchase) {
      req.flash("error", `Purchase #${purchaseNumber} not found.`);
      return res.redirect("back");
    }

    const doc = await mdb.PAPERLESS.OcrDocument.findOne({ paperlessId }).lean();
    if (!doc || doc.documentType?.name !== "statement") {
      return res.status(404).redirect("back");
    }

    const numbers = parseStatementInvoiceNumbers(doc);
    if (numbers.includes(purchaseNumber)) {
      req.flash("error", `Purchase #${purchaseNumber} is already on this statement.`);
      return res.redirect("back");
    }

    numbers.push(purchaseNumber);
    await saveStatementInvoiceNumbers(paperlessId, numbers);

    logger.info(`[attendanceController] Added purchase #${purchaseNumber} to statement paperlessId=${paperlessId}`);
    req.flash("success", `Purchase #${purchaseNumber} added to statement.`);
    res.redirect("back");
  } catch (err) {
    logger.error(`[attendanceController] Error adding purchase to statement: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

/**
 * POST /statement/:paperlessId/remove-purchase
 * Removes a purchase number from the statement's "Invoice Number" custom field.
 */
export const removeStatementPurchase = async (req, res, next) => {
  try {
    const paperlessId = parseInt(req.params.paperlessId, 10);
    const purchaseNumber = String(req.body.purchaseNumber || "").trim();
    if (!purchaseNumber) {
      req.flash("error", "Purchase number is required.");
      return res.redirect("back");
    }

    const doc = await mdb.PAPERLESS.OcrDocument.findOne({ paperlessId }).lean();
    if (!doc || doc.documentType?.name !== "statement") {
      return res.status(404).redirect("back");
    }

    const numbers = parseStatementInvoiceNumbers(doc);
    const filtered = numbers.filter((n) => n !== purchaseNumber);
    if (filtered.length === numbers.length) {
      req.flash("error", `Purchase #${purchaseNumber} is not on this statement.`);
      return res.redirect("back");
    }

    await saveStatementInvoiceNumbers(paperlessId, filtered);

    logger.info(`[attendanceController] Removed purchase #${purchaseNumber} from statement paperlessId=${paperlessId}`);
    req.flash("success", `Purchase #${purchaseNumber} removed from statement.`);
    res.redirect("back");
  } catch (err) {
    logger.error(`[attendanceController] Error removing purchase from statement: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

// ── Inline cell editing API ─────────────────────────────────────────────

const VALID_TYPES = ["work", "training", "sick", "holiday", "off", "leave"];

/**
 * PATCH /attendance/:uuid
 * Update fields on a pending attendance record. Returns JSON.
 * Only admin/accountant may call this (enforced in routes).
 */
export const updateAttendance = async (req, res, next) => {
  try {
    const record = await mdb.INTERNAL.attendance
      .findOne({ uuid: req.params.uuid })
      .lean();

    if (!record) {
      return res.status(404).json({ success: false, error: "Record not found." });
    }
    if (record.status !== "pending") {
      return res.status(403).json({
        success: false,
        error: "Only pending records can be edited.",
      });
    }

    const { type, hoursWorked, dayRate, locationId, contractId } = req.body;

    // A Supervisor or Site Manager edits only records on their sites, and
    // can't move one off them.
    const scope = await approval.writeScopeFor(req);
    if (scope !== null) {
      const onSite = approval.contractInScope(scope, record.contractId)
        || (!record.contractId && record.projectId && scope.projectIds.some((p) => String(p) === String(record.projectId)));
      if (!onSite) return res.status(403).json({ success: false, error: "This record isn't on one of your sites." });
      if (contractId !== undefined && !approval.contractInScope(scope, contractId)) {
        return res.status(403).json({ success: false, error: "That contract isn't one of your sites." });
      }
    }
    if (dayRate != null && !rbac.canSeeValues(req.user)) {
      return res.status(403).json({ success: false, error: "You can't set a day rate." });
    }

    if (type !== undefined && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid type." });
    }

    // hoursWorked and dayRate are mutually exclusive
    if (hoursWorked != null && dayRate != null) {
      return res.status(400).json({
        success: false,
        error: "hoursWorked and dayRate are mutually exclusive.",
      });
    }

    const update = {};
    if (type !== undefined) update.type = type;
    if (hoursWorked != null) {
      update.hoursWorked = Number(hoursWorked);
      update.dayRate = undefined; // clear the other
    }
    if (dayRate != null) {
      update.dayRate = Number(dayRate);
      update.$unset = { hoursWorked: 1 };
    }
    if (hoursWorked == null && dayRate == null && type !== undefined) {
      // type-only change — don't touch pay fields
    }
    if (locationId !== undefined) update.locationId = locationId || null;
    if (contractId !== undefined) update.contractId = contractId || null;

    const updated = await mdb.INTERNAL.attendance.findOneAndUpdate(
      { uuid: req.params.uuid, status: "pending" },
      update,
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(409).json({
        success: false,
        error: "Record was modified concurrently. Please refresh.",
      });
    }

    logger.info(`[attendanceController] Inline updated attendance ${req.params.uuid}`);
    return res.json({
      success: true,
      record: {
        uuid: updated.uuid,
        type: updated.type,
        hoursWorked: updated.hoursWorked != null ? Number(updated.hoursWorked) : null,
        dayRate: updated.dayRate != null ? Number(updated.dayRate) : null,
        locationId: updated.locationId ? String(updated.locationId) : null,
        contractId: updated.contractId ? String(updated.contractId) : null,
        status: updated.status,
      },
    });
  } catch (err) {
    logger.error(`[attendanceController] Inline update attendance error: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

/**
 * POST /attendance/inline
 * Create a new pending attendance record via inline cell editor. Returns JSON.
 * Only admin/accountant may call this (enforced in routes).
 */
export const inlineCreateAttendance = async (req, res, next) => {
  try {
    const {
      employeeId,
      subcontractorId,
      date,
      type,
      hoursWorked,
      dayRate,
      locationId,
      contractId,
    } = req.body;

    // Validate: exactly one entity
    if ((!employeeId && !subcontractorId) || (employeeId && subcontractorId)) {
      return res.status(400).json({
        success: false,
        error: "Provide exactly one of employeeId or subcontractorId.",
      });
    }

    // Validate date
    const parsedDate = parseYMDLocal(date);
    if (!parsedDate) {
      return res.status(400).json({ success: false, error: "Invalid date." });
    }

    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid type." });
    }

    if (hoursWorked != null && dayRate != null) {
      return res.status(400).json({
        success: false,
        error: "hoursWorked and dayRate are mutually exclusive.",
      });
    }

    // A Supervisor or Site Manager records only on contracts that name them
    const scope = await approval.writeScopeFor(req);
    if (scope !== null && !approval.contractInScope(scope, contractId)) {
      return res.status(403).json({ success: false, error: "Choose one of your sites' contracts." });
    }
    if (dayRate != null && !rbac.canSeeValues(req.user)) {
      return res.status(403).json({ success: false, error: "You can't set a day rate." });
    }

    const data = {
      date: parsedDate,
      type: type || "work",
      status: "pending",
    };

    if (employeeId) {
      // employeeId is always passed as a MongoDB ObjectId string from the template
      data.employeeId = employeeId;
    }
    if (subcontractorId) {
      // subcontractorId may be a UUID (from the weekly table) — look up the supplier ObjectId
      if (mongoose.Types.ObjectId.isValid(subcontractorId)) {
        data.subcontractorId = subcontractorId;
      } else {
        const supplier = await mdb.REST.supplier
          .findOne({ uuid: subcontractorId })
          .select("_id")
          .lean();
        if (!supplier) {
          return res.status(400).json({ success: false, error: "Subcontractor not found." });
        }
        data.subcontractorId = supplier._id;
      }
    }
    if (hoursWorked != null) data.hoursWorked = Number(hoursWorked);
    if (dayRate != null) data.dayRate = Number(dayRate);
    if (locationId) data.locationId = locationId;
    if (contractId) data.contractId = contractId;

    // Payroll lock: admins may correct locked periods, others may not
    if (req.user?.role !== "admin") {
      const lockedRun = await attendanceService.getLockedRunForDate(data.date);
      if (lockedRun) {
        return res.status(409).json({
          success: false,
          error: `This date falls in a ${lockedRun.status} payroll period and can no longer be edited.`,
        });
      }
    }

    const record = new mdb.INTERNAL.attendance(data);
    await record.save();

    logger.info(`[attendanceController] Inline created attendance ${record.uuid} for date ${date}`);
    return res.status(201).json({
      success: true,
      record: {
        uuid: record.uuid,
        type: record.type,
        hoursWorked: record.hoursWorked != null ? Number(record.hoursWorked) : null,
        dayRate: record.dayRate != null ? Number(record.dayRate) : null,
        locationId: record.locationId ? String(record.locationId) : null,
        contractId: record.contractId ? String(record.contractId) : null,
        status: record.status,
        date,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error:
          "An attendance record already exists for this person on this date with the same location/project.",
      });
    }
    logger.error(`[attendanceController] Inline create attendance error: ${err.message}`, { stack: err.stack });
    next(err);
  }
};

// ── Inline assignment editing API ───────────────────────────────────────

/**
 * POST /assignment/inline
 * Create a new assignment for this week's contract. Returns JSON.
 */
export const inlineCreateAssignment = async (req, res, next) => {
  try {
    const { contractId, weekStart, title, description, assignedEmployees, assignedSubcontractors, estimatedHours, status } = req.body;

    if (!contractId) return res.status(400).json({ success: false, error: 'contractId is required.' });
    const parsedWeekStart = parseYMDLocal(weekStart);
    if (!parsedWeekStart) {
      return res.status(400).json({ success: false, error: 'Invalid weekStart date.' });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'title is required.' });
    }

    const data = {
      contractId,
      weekStart: parsedWeekStart,
      title: String(title).trim(),
    };
    if (description) data.description = String(description).trim();
    if (Array.isArray(assignedEmployees)) data.assignedEmployees = assignedEmployees;
    if (Array.isArray(assignedSubcontractors)) data.assignedSubcontractors = assignedSubcontractors;
    if (estimatedHours != null) data.estimatedHours = Number(estimatedHours);
    if (status) data.status = status;

    const record = new mdb.INTERNAL.assignment(data);
    await record.save();

    logger.info(`[attendanceController] Inline created assignment ${record.uuid} for contract ${contractId}`);
    return res.status(201).json({ success: true });
  } catch (err) {
    logger.error(`[attendanceController] Inline create assignment error: ${err.message}`);
    next(err);
  }
};

/**
 * PATCH /assignment/:uuid
 * Update fields on an assignment. Returns JSON.
 */
export const updateAssignment = async (req, res, next) => {
  try {
    const record = await mdb.INTERNAL.assignment.findOne({ uuid: req.params.uuid }).lean();
    if (!record) return res.status(404).json({ success: false, error: 'Assignment not found.' });

    const { title, description, assignedEmployees, assignedSubcontractors, estimatedHours, status } = req.body;
    const VALID_STATUSES = ['Planned', 'In Progress', 'Done'];

    const update = {};
    if (title !== undefined) update.title = String(title).trim();
    if (description !== undefined) update.description = String(description).trim();
    if (Array.isArray(assignedEmployees)) update.assignedEmployees = assignedEmployees;
    if (Array.isArray(assignedSubcontractors)) update.assignedSubcontractors = assignedSubcontractors;
    if (estimatedHours != null) update.estimatedHours = Number(estimatedHours);
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status.' });
      update.status = status;
    }

    const updated = await mdb.INTERNAL.assignment
      .findOneAndUpdate({ uuid: req.params.uuid }, update, { new: true, runValidators: true })
      .lean();

    if (!updated) return res.status(404).json({ success: false, error: 'Assignment not found.' });

    logger.info(`[attendanceController] Inline updated assignment ${req.params.uuid}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error(`[attendanceController] Inline update assignment error: ${err.message}`);
    next(err);
  }
};

// ── Inline vehicle deployment editing API ───────────────────────────────

const VALID_USAGE_TYPES = ['site', 'delivery', 'maintenance', 'office', 'other'];

/**
 * POST /vehicle-deployment/inline
 * Create a new vehicle deployment record for a specific vehicle and date. Returns JSON.
 */
export const inlineCreateVehicleDeployment = async (req, res, next) => {
  try {
    const { vehicleId, date, driverEmployeeId, driverSubcontractorId, locationId, contractId, startMileage, endMileage, usageType, notes } = req.body;

    if (!vehicleId) return res.status(400).json({ success: false, error: 'vehicleId is required.' });
    const parsedDeployDate = parseYMDLocal(date);
    if (!parsedDeployDate) {
      return res.status(400).json({ success: false, error: 'Invalid date.' });
    }
    if (driverEmployeeId && driverSubcontractorId) {
      return res.status(400).json({ success: false, error: 'Provide at most one of driverEmployeeId or driverSubcontractorId.' });
    }
    if (usageType && !VALID_USAGE_TYPES.includes(usageType)) {
      return res.status(400).json({ success: false, error: 'Invalid usageType.' });
    }

    const data = {
      vehicleId,
      date: parsedDeployDate,
      usageType: usageType || 'site',
    };
    if (driverEmployeeId) data.driverEmployeeId = driverEmployeeId;
    if (driverSubcontractorId) data.driverSubcontractorId = driverSubcontractorId;
    if (locationId) data.locationId = locationId;
    if (contractId) data.contractId = contractId;
    if (startMileage != null) data.startMileage = Number(startMileage);
    if (endMileage != null) data.endMileage = Number(endMileage);
    if (notes) data.notes = String(notes).trim();

    const record = new mdb.INTERNAL.vehicleDeployment(data);
    await record.save();

    const populated = await mdb.INTERNAL.vehicleDeployment
      .findById(record._id)
      .populate('vehicleId', '_id uuid registrationNumber make model bodyType')
      .populate('driverEmployeeId', '_id uuid name')
      .populate('driverSubcontractorId', '_id uuid Name')
      .populate('locationId', '_id uuid name')
      .populate('contractId', '_id uuid title location')
      .lean();

    logger.info(`[attendanceController] Inline created vehicle deployment ${record.uuid} for vehicle ${vehicleId} on ${date}`);
    return res.status(201).json({ success: true, record: populated });
  } catch (err) {
    logger.error(`[attendanceController] Inline create vehicle deployment error: ${err.message}`);
    next(err);
  }
};

/**
 * PATCH /vehicle-deployment/:uuid
 * Update a vehicle deployment record. Returns JSON.
 */
export const updateVehicleDeployment = async (req, res, next) => {
  try {
    const record = await mdb.INTERNAL.vehicleDeployment.findOne({ uuid: req.params.uuid }).lean();
    if (!record) return res.status(404).json({ success: false, error: 'Vehicle deployment not found.' });

    const { driverEmployeeId, driverSubcontractorId, locationId, contractId, startMileage, endMileage, usageType, notes } = req.body;

    if (driverEmployeeId && driverSubcontractorId) {
      return res.status(400).json({ success: false, error: 'Provide at most one of driverEmployeeId or driverSubcontractorId.' });
    }
    if (usageType && !VALID_USAGE_TYPES.includes(usageType)) {
      return res.status(400).json({ success: false, error: 'Invalid usageType.' });
    }

    const update = {};
    if (driverEmployeeId !== undefined) update.driverEmployeeId = driverEmployeeId || null;
    if (driverSubcontractorId !== undefined) update.driverSubcontractorId = driverSubcontractorId || null;
    if (locationId !== undefined) update.locationId = locationId || null;
    if (contractId !== undefined) update.contractId = contractId || null;
    if (startMileage != null) update.startMileage = Number(startMileage);
    if (endMileage != null) update.endMileage = Number(endMileage);
    if (usageType !== undefined) update.usageType = usageType;
    if (notes !== undefined) update.notes = String(notes || '').trim() || null;

    const updated = await mdb.INTERNAL.vehicleDeployment
      .findOneAndUpdate({ uuid: req.params.uuid }, update, { new: true, runValidators: true })
      .populate('vehicleId', '_id uuid registrationNumber make model bodyType')
      .populate('driverEmployeeId', '_id uuid name')
      .populate('driverSubcontractorId', '_id uuid Name')
      .populate('locationId', '_id uuid name')
      .populate('contractId', '_id uuid title location')
      .lean();

    if (!updated) return res.status(404).json({ success: false, error: 'Vehicle deployment not found.' });

    logger.info(`[attendanceController] Inline updated vehicle deployment ${req.params.uuid}`);
    return res.json({ success: true, record: updated });
  } catch (err) {
    logger.error(`[attendanceController] Inline update vehicle deployment error: ${err.message}`);
    next(err);
  }
};


export default { getDailyAttendance, recordDay, getWeeklyAttendance, approveAttendance, rejectAttendance, bulkApproveAttendance, renderSubmitAttendance, submitAttendance, addStatementPurchase, removeStatementPurchase, updateAttendance, inlineCreateAttendance, inlineCreateAssignment, updateAssignment, inlineCreateVehicleDeployment, updateVehicleDeployment };
