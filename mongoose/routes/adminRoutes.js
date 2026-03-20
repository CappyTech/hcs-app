const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/adminController");

router.get(
  "/admin/deleted-items",
  authService.ensureRole("admin"),
  ctrl.getDeletedItems,
);

module.exports = router;
