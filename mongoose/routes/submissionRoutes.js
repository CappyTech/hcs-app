const express = require("express");
const router = express.Router();
const path = require("path");
const authService = require("../../services/authService");
const controller = require(
  path.join("..", "controllers", "submissionController"),
);

// Admin only — previously had NO auth middleware
router.post(
  "/receipts/change-submission",
  authService.ensureRole("admin"),
  controller.changeReceipts,
);
router.post(
  "/purchase/change",
  authService.ensureRole("admin"),
  controller.changePurchases,
);

module.exports = router;
