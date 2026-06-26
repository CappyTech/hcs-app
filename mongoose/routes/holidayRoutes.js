const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/holidayController");

// Holiday Management landing page — accrual, requests and the holiday calendar.
// Aggregates data across all employees, so it is restricted to admins, matching
// the other management/overview hubs (e.g. /overview/human, /overview/fleet).
router.get(
  "/holiday",
  authService.ensureRole("admin"),
  async (req, res, next) => {
    try {
      await ctrl.getHolidayManagement(req, res, next);
    } catch (err) {
      next(err);
    }
  },
);

// Any authenticated user can dismiss a holiday notification
router.post(
  "/holiday/dismiss",
  authService.ensureAnyRole(),
  async (req, res, next) => {
    try {
      await ctrl.dismissHoliday(req, res, next);
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
