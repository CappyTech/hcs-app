const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/dailyAttendanceController');

router.get('/attendance/daily/:date?', ctrl.getDailyAttendance);

module.exports = router;
