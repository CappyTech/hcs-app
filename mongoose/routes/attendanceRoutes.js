const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceController');

router.get('/attendance/weekly', authService.ensureRole(), (req,res,next)=>{
  const currentYear = require('../../services/taxService').getCurrentTaxYear();
  res.redirect(`/attendance/weekly/${currentYear}`);
});
router.get('/attendance/weekly/:year?/:week?', authService.ensureRole(), ctrl.getWeeklyAttendance);

module.exports = router;