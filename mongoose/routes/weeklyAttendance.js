const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/weeklyAttendanceController');

router.get('/daily/:date?', authService.ensureRole(), ctrl.getDailyAttendance);
router.get('/weekly', authService.ensureRole(), (req,res,next)=>{
  const { currentYear, currentMonth } = require('../../services/taxService').getCurrentTaxYear();
  res.redirect(`/weekly/${currentYear}/${currentMonth}`);
});
router.get('/weekly/:year?/:week?', authService.ensureRole(), ctrl.getWeeklyAttendance);

module.exports = router;
