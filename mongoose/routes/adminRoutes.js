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

module.exports = router;
