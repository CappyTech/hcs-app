const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/adminController");

router.get(
  "/admin/deleted-items",
  authService.ensureRole("admin"),
  ctrl.getDeletedItems,
);

router.get(
  "/admin/ui-guidelines",
  authService.ensureRole("admin"),
  ctrl.getUiGuidelines,
);

router.get(
  "/admin/gdpr",
  authService.ensureRole("admin"),
  ctrl.getGdprOverview,
);

router.get(
  "/admin/gdpr/ropa",
  authService.ensureRole("admin"),
  ctrl.downloadRopa,
);

router.get(
  "/admin/gdpr/incident-response",
  authService.ensureRole("admin"),
  ctrl.viewIncidentResponse,
);

router.get(
  "/admin/gdpr/dpia-template",
  authService.ensureRole("admin"),
  ctrl.viewDpiaTemplate,
);

router.get(
  "/admin/jobs",
  authService.ensureRole("admin"),
  ctrl.getJobs,
);

router.get(
  "/admin/security-events",
  authService.ensureRole("admin"),
  ctrl.getSecurityEvents,
);

router.get(
  "/admin/maintenance",
  authService.ensureRole("admin"),
  ctrl.getMaintenance,
);

router.post(
  "/admin/maintenance",
  authService.ensureRole("admin"),
  ctrl.postMaintenance,
);

router.post(
  "/admin/jobs/:name/run",
  authService.ensureRole("admin"),
  ctrl.runJob,
);

module.exports = router;
