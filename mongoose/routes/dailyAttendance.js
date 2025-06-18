const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/dailyAttendanceController');

router.get('/attendance/daily/:date?', authService.ensureRole(), ctrl.getDailyAttendance);

module.exports = router;
