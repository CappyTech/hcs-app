const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceController');

router.get('/daily/:date?', authService.ensureRole(), ctrl.getDailyAttendance);
router.get('/weekly/:year?/:week?', authService.ensureRole(), ctrl.getWeeklyAttendance);
router.get('/weekly-management/:year?/:week?', authService.ensureRole(), (req, res, next) => {
  req.isManagementView = true;
  ctrl.getWeeklyAttendance(req, res, next);
});

module.exports = router;
