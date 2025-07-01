const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceController');

router.get('/daily/:date?', authService.ensureRole(), ctrl.getDailyAttendance);
router.get('/weekly/:year?/:week?', authService.ensureRole(), ctrl.getWeeklyAttendance);

module.exports = router;
