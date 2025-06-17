const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/weeklyAttendanceController');

router.get('/attendance/weekly', auth.ensureAuthenticated, auth.ensureRole('admin'), (req,res,next)=>{
  const currentYear = require('../../services/taxService').getCurrentTaxYear();
  res.redirect(`/attendance/weekly/${currentYear}`);
});
router.get('/attendance/weekly/:year?/:week?', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.getWeeklyAttendance);

module.exports = router;
