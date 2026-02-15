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

// Approval workflow
router.post('/attendance/:uuid/approve', authService.ensureRole('admin'), ctrl.approveAttendance);
router.post('/attendance/:uuid/reject', authService.ensureRole('admin'), ctrl.rejectAttendance);

module.exports = router;
