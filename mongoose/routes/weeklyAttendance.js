const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/weeklyAttendanceController');

router.get('/attendance/weekly', auth.ensureRole(), (req,res,next)=>{
  const currentYear = require('../../services/taxService').getCurrentTaxYear();
  res.redirect(`/attendance/weekly/${currentYear}`);
});
router.get('/attendance/weekly/:year?/:week?', auth.ensureRole(), ctrl.getWeeklyAttendance);

module.exports = router;
