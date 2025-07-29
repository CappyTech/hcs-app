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
      date
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

    const isManagementView = req.isManagementView === true;

    const employeeEntries = Object.entries(groupedAttendance)
      .filter(([_, v]) => v.type === 'employee')
      .map(([uuid, v]) => [uuid, isManagementView ? stripPayroll(v) : v]);

    const subcontractorEntries = Object.entries(groupedAttendance)
      .filter(([_, v]) => v.type === 'subcontractor')
      .map(([uuid, v]) => [uuid, isManagementView ? stripPayroll(v) : v]);

    const viewFile = isManagementView ? 'weeklyManagement' : 'weeklyAdmin';
    res.render(path.join('tailwindcss', 'attendance', viewFile), {
      moment,
      groupedAttendance: groupedAttendance, // prevent table reuse
      startDate: payrollWeekStart.format('YYYY-MM-DD'),
      endDate: endDate.format('YYYY-MM-DD'),
      previousYear,
      previousWeek,
      nextYear,
      nextWeek,
      employeeCount,
      subcontractorCount,
      totalEmployeePay: isManagementView ? null : totalEmployeePay,
      totalEmployeeHours: isManagementView ? null : totalEmployeeHours,
      totalSubcontractorPay: isManagementView ? null : totalSubcontractorPay,
      totalSubcontractorDays: isManagementView ? null : totalSubcontractorDays,
      daysOfWeek,
      activeJobs,
      employeeEntries,
      subcontractorEntries,
      isManagementView
    });
  } catch (err) {
    next(err);
  }
};

function stripPayroll(record) {
  const clone = { ...record };
  delete clone.totalPay;
  delete clone.hoursWorked;
  delete clone.payRate;
  delete clone.totalHours;
  delete clone.daysWorked;
  delete clone.cisDeductions;
  return clone;
}