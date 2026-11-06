import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/attendanceController.js';
import flow from '../controllers/weeklyFlowController.js';

// Permission groups (accessGroupsConfig): Site Ops view reads the daily and
// weekly views, edit records attendance and assignments, approve signs them
// off. Each guard also names the legacy roles that had the route before.

// Daily / weekly views — admin and accountant see all; employee/subcontractor
// see their own (scoped in controller). The accountant is here because payroll
// is a periodic run over the period's attendance, and Payroll is an
// admin+accountant department that previously linked to a page its own users
// could not open.
const SITE_VIEW_ROLES = ["admin", "accountant", "employee", "subcontractor"];
// /daily filters each record by the viewer's scope, so a project-scoped
// Site Ops grant (Site Manager, Supervisor) reaches it and sees its sites.
router.get(
  "/daily/:date?",
  authService.ensureGroup([{ group: "siteOps", level: "view", project: true }], null, ...SITE_VIEW_ROLES),
  ctrl.getDailyAttendance,
);
router.get(
  "/weekly/:year?/:week?",
  authService.ensureGroup("siteOps", "view", ...SITE_VIEW_ROLES),
  ctrl.getWeeklyAttendance,
);
// The management view shows what was paid, so it sits with approve.
router.get(
  "/weekly-management/:year?/:week?",
  authService.ensureGroup("siteOps", "approve"),
  (req, res, next) => {
    req.isManagementView = true;
    ctrl.getWeeklyAttendance(req, res, next);
  },
);

// Weekly attendance flow: contracts → assignments → attendance → approve.
// Payroll view reads it (it feeds the pay run); Site Ops edit works it. The
// approve step on the page needs Site Ops approve (weeklyFlowController).
router.get(
  "/weekly-flow/:year?/:week?",
  authService.ensureGroup(
    [{ group: "siteOps", level: "edit" }, { group: "payroll", level: "view" }],
    null, "admin", "accountant",
  ),
  flow.getWeekFlow,
);
router.post(
  "/weekly-flow/:year/:week/assignments",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  flow.postAssignment,
);
router.post(
  "/weekly-flow/:year/:week/copy-previous",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  flow.postCopyPrevious,
);
router.post(
  "/weekly-flow/:year/:week/record",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  flow.postRecord,
);

// Self-service attendance submission (employee / subcontractor)
router.get(
  "/attendance/submit",
  authService.ensureRoles("employee", "subcontractor"),
  ctrl.renderSubmitAttendance,
);
router.post(
  "/attendance/submit",
  authService.ensureRoles("employee", "subcontractor"),
  ctrl.submitAttendance,
);

// Inline editing API — admin/accountant + Site Ops edit (must come before /:uuid wildcard routes)
router.post(
  "/attendance/inline",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  ctrl.inlineCreateAttendance,
);
router.patch(
  "/attendance/:uuid",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  ctrl.updateAttendance,
);

// Approval workflow — admin + Site Ops approve. One step for now; phase 3
// splits it into Site Manager then Contracts Manager (docs/PERMISSION-GROUPS.md).
router.post(
  "/attendance/bulk-approve",
  authService.ensureGroup("siteOps", "approve"),
  ctrl.bulkApproveAttendance,
);
router.post(
  "/attendance/:uuid/approve",
  authService.ensureGroup("siteOps", "approve"),
  ctrl.approveAttendance,
);
router.post(
  "/attendance/:uuid/reject",
  authService.ensureGroup("siteOps", "approve"),
  ctrl.rejectAttendance,
);

// Statement purchase management — admin only
router.post(
  "/statement/:paperlessId/add-purchase",
  authService.ensureRole("admin"),
  ctrl.addStatementPurchase,
);
router.post(
  "/statement/:paperlessId/remove-purchase",
  authService.ensureRole("admin"),
  ctrl.removeStatementPurchase,
);

// Inline assignment editing — admin/accountant + Site Ops edit
router.post(
  "/assignment/inline",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  ctrl.inlineCreateAssignment,
);
router.patch(
  "/assignment/:uuid",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  ctrl.updateAssignment,
);

// Inline vehicle deployment editing — admin/accountant + Site Ops edit
router.post(
  "/vehicle-deployment/inline",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  ctrl.inlineCreateVehicleDeployment,
);
router.patch(
  "/vehicle-deployment/:uuid",
  authService.ensureGroup("siteOps", "edit", "admin", "accountant"),
  ctrl.updateVehicleDeployment,
);

export default router;
