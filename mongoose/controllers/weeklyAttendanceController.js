const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');
const attendanceService = require('../services/attendanceServicesMongoose');
const taxService = require('../../services/taxService');

exports.getWeeklyAttendance = async (req,res,next)=>{
  try {
    const yearParam = parseInt(req.params.year);
    const weekParam = parseInt(req.params.week);
    const year = !isNaN(yearParam) ? yearParam : taxService.getCurrentTaxYear();
    const { start: startOfTaxYear, end: endOfTaxYear } = taxService.getTaxYearStartEnd(year);
    const taxYearStart = moment.tz(startOfTaxYear,'Do MMMM YYYY','Europe/London');
    const taxYearEnd = moment.tz(endOfTaxYear,'Do MMMM YYYY','Europe/London');
    let firstPayrollWeekStart = taxYearStart.clone().day(6);
    if(firstPayrollWeekStart.isBefore(taxYearStart)) firstPayrollWeekStart.add(7,'days');
    const totalWeeksInYear = taxYearEnd.diff(firstPayrollWeekStart,'weeks')+1;
    const today = moment.tz('Europe/London');
    let requestedWeekNumber = !isNaN(weekParam)?weekParam:today.diff(firstPayrollWeekStart,'weeks')+1;
    if(requestedWeekNumber<1) requestedWeekNumber=1;
    if(requestedWeekNumber>totalWeeksInYear) requestedWeekNumber=totalWeeksInYear;
    const payrollWeekStart = firstPayrollWeekStart.clone().add((requestedWeekNumber-1)*7,'days');
    const endDate = payrollWeekStart.clone().add(6,'days');
    const previousWeek = requestedWeekNumber===1?totalWeeksInYear:requestedWeekNumber-1;
    const previousYear = requestedWeekNumber===1?year-1:year;
    const nextWeek = requestedWeekNumber===totalWeeksInYear?1:requestedWeekNumber+1;
    const nextYear = requestedWeekNumber===totalWeeksInYear?year+1:year;
    const { attendanceRecords, employeeCount, subcontractorCount, allEmployees, allSubcontractors, paidReceipts } = await attendanceService.getAttendanceForWeek(payrollWeekStart,endDate);
    const { groupedAttendance, totalEmployeeHours, totalEmployeePay, totalSubcontractorPay, daysOfWeek } = attendanceService.groupAttendanceByPerson(attendanceRecords,payrollWeekStart,endDate,allEmployees,allSubcontractors,paidReceipts);
    const activeJobs = await mdb.job.find({
      startDate: { $lte: endDate.toDate() },
      $or: [{ endDate: null }, { endDate: { $gte: payrollWeekStart.toDate() } }],
      status: { $ne: "archived" }
    }).populate("projectId").populate("locationId").lean();
    res.render(path.join('mongoose','weeklyAttendance'),{
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
      currentTab:'weekly',
      daysOfWeek,
      activeJobs
    });
  }catch(err){
    next(err);
  }
};
