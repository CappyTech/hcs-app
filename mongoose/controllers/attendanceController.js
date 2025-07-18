const path = require('path');
const moment = require('moment-timezone');
const attendanceService = require('../services/attendanceServicesMongoose');

exports.getDailyAttendance = async (req,res,next)=>{
  const date = req.params.date || moment().format('YYYY-MM-DD');
  try {
    const attendance = await attendanceService.getAttendanceForDay(date);
    res.render(path.join('tailwindcss', 'attendance', 'daily'), {
      moment,
      attendance,
      date,
      currentTab:'daily'
    });
  }catch(err){
    next(err);
  }
};

exports.getWeeklyAttendance = async (req, res, next) => {
  try {
    const yearParam = parseInt(req.params.year);
    const weekParam = parseInt(req.params.week);

    const {
      groupedAttendance,
      payrollWeekStart,
      endDate,
      previousYear,
      previousWeek,
      nextYear,
      nextWeek,
      employeeCount,
      subcontractorCount,
      totalEmployeePay,
      totalEmployeeHours,
      totalSubcontractorPay,
      totalSubcontractorDays,
      daysOfWeek,
      activeJobs
    } = await attendanceService.getAttendanceForWeek(yearParam, weekParam);

    const employeeEntries = Object.entries(groupedAttendance)
      .filter(([_, v]) => v.type === 'employee')
      .map(([uuid, v]) => [uuid, { ...v }]);

    const subcontractorEntries = Object.entries(groupedAttendance)
      .filter(([_, v]) => v.type === 'subcontractor')
      .map(([uuid, v]) => [uuid, { ...v }]);

    res.render(path.join('tailwindcss', 'attendance', 'weekly'), {
      moment,
      groupedAttendance,
      startDate: payrollWeekStart.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      previousYear,
      previousWeek,
      nextYear,
      nextWeek,
      employeeCount,
      subcontractorCount,
      totalEmployeePay,
      totalEmployeeHours,
      totalSubcontractorPay,
      totalSubcontractorDays,
      currentTab: 'weekly',
      daysOfWeek,
      activeJobs,
      employeeEntries,
      subcontractorEntries
    });
  } catch (err) {
    next(err);
  }
};

