const path = require('path');
const moment = require('moment-timezone');
const attendanceService = require('../services/attendanceServicesMongoose');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

exports.getDailyAttendance = async (req,res,next)=>{
  const date = req.params.date || moment().format('YYYY-MM-DD');
  try {
    const attendance = await attendanceService.getAttendanceForDay(date);
    res.render(path.join('tailwindcss', 'attendance', 'daily'), {
      title: `Attendance for ${moment(date).format('DD MMMM YYYY')}`,
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
      activeProjects,
      projectStatusFilter,
      taxWeekNumber,
      taxYear
    } = await attendanceService.getAttendanceForWeek(yearParam, weekParam);

    const isManagementView = req.isManagementView === true;

    const employeeEntries = Object.entries(groupedAttendance)
      .filter(([_, v]) => v.type === 'employee')
      .map(([uuid, v]) => [uuid, isManagementView ? stripPayroll(v) : v]);

    const subcontractorEntries = Object.entries(groupedAttendance)
      .filter(([_, v]) => v.type === 'subcontractor')
      .map(([uuid, v]) => [uuid, isManagementView ? stripPayroll(v) : v]);

    const viewFile = isManagementView ? 'weeklyManagement' : 'weeklyAdmin';
    res.render(path.join('tailwindcss', 'attendance', 'weekly'), {
      title : `Tax Week ${taxWeekNumber} — ${payrollWeekStart.format('YYYY')}`,
      moment,
      groupedAttendance: groupedAttendance,
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
      activeProjects,
      projectStatusFilter,
      employeeEntries,
      subcontractorEntries,
      isManagementView,
      taxWeekNumber,
      taxYear
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

exports.approveAttendance = async (req, res, next) => {
  try {
    const updated = await mdb.INTERNAL.attendance.findOneAndUpdate(
      { uuid: req.params.uuid, status: 'pending' },
      { status: 'approved' },
      { new: true }
    );
    if (!updated) {
      logger.warn(`Approve failed: attendance ${req.params.uuid} not found or not pending`);
      return res.status(404).redirect('back');
    }
    // Trigger holiday accrual now that it's approved
    const holidayAccrualService = require('../services/holidayAccrualService');
    await holidayAccrualService.updateAccrualFromAttendance(updated);
    logger.info(`✅ Attendance ${req.params.uuid} approved`);
    res.redirect('back');
  } catch (err) {
    logger.error(`❌ Error approving attendance: ${err.message}`);
    next(err);
  }
};

exports.rejectAttendance = async (req, res, next) => {
  try {
    const updated = await mdb.INTERNAL.attendance.findOneAndUpdate(
      { uuid: req.params.uuid, status: 'pending' },
      { status: 'rejected' },
      { new: true }
    );
    if (!updated) {
      logger.warn(`Reject failed: attendance ${req.params.uuid} not found or not pending`);
      return res.status(404).redirect('back');
    }
    logger.info(`❌ Attendance ${req.params.uuid} rejected`);
    res.redirect('back');
  } catch (err) {
    logger.error(`❌ Error rejecting attendance: ${err.message}`);
    next(err);
  }
};