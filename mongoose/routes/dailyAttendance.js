const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/dailyAttendanceController');

router.get('/attendance/daily/:date?', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.getDailyAttendance);

module.exports = router;
