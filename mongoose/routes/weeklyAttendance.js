const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/weeklyAttendanceController');

router.get('/attendance/weekly',  auth.ensureRoles(['adminAccess']), (req,res,next)=>{
  const currentYear = require('../../services/taxService').getCurrentTaxYear();
  res.redirect(`/attendance/weekly/${currentYear}`);
});
router.get('/attendance/weekly/:year?/:week?',  auth.ensureRoles(['adminAccess']), ctrl.getWeeklyAttendance);

module.exports = router;
