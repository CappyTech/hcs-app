const express = require("express");
const router = express.Router();
const path = require("path");
const authService = require("../../services/authService");
const controller = require(
  path.join("..", "controllers", "subcontractorController"),
);

// Admin only — previously had NO auth middleware
router.get(
  "/subcontractor/assign",
  authService.ensureRole("admin"),
  controller.renderAssignForm,
);
router.post(
  "/subcontractor/assign",
  authService.ensureRole("admin"),
  controller.assignSubcontractor,
);
router.get(
  "/supplier/change/:uuid",
  authService.ensureRole("admin"),
  controller.renderChangeSupplierForm,
);
router.post(
  "/supplier/change/:uuid",
  authService.ensureRole("admin"),
  controller.changeSupplier,
);

module.exports = router;
