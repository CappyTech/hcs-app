const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/attendanceController");

// Daily / weekly views — admin sees all; employee/subcontractor sees own (scoped in controller)
router.get(
  "/daily/:date?",
  authService.ensureRoles("admin", "employee", "subcontractor"),
  ctrl.getDailyAttendance,
);
router.get(
  "/weekly/:year?/:week?",
  authService.ensureRoles("admin", "employee", "subcontractor"),
  ctrl.getWeeklyAttendance,
);
router.get(
  "/weekly-management/:year?/:week?",
  authService.ensureRole("admin"),
  (req, res, next) => {
    req.isManagementView = true;
    ctrl.getWeeklyAttendance(req, res, next);
  },
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

// Approval workflow — admin only
router.post(
  "/attendance/bulk-approve",
  authService.ensureRole("admin"),
  ctrl.bulkApproveAttendance,
);
router.post(
  "/attendance/:uuid/approve",
  authService.ensureRole("admin"),
  ctrl.approveAttendance,
);
router.post(
  "/attendance/:uuid/reject",
  authService.ensureRole("admin"),
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

module.exports = router;
