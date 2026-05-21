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

module.exports = router;
