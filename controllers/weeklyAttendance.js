const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');
const path = require('path');
const logger = require('../services/loggerService');
const attendanceService = require('../services/attendanceService');
const authService = require('../services/authService');
const taxService = require('../services/taxService');

const getWeeklyAttendance = async (req, res, next) => {
    try {
        const yearParam = parseInt(req.params.year);
        const weekParam = parseInt(req.params.week);
        const year = !isNaN(yearParam) ? yearParam : taxService.getCurrentTaxYear();
        const { start: startOfTaxYear, end: endOfTaxYear } = taxService.getTaxYearStartEnd(year);

        const taxYearStart = moment.tz(startOfTaxYear, 'Do MMMM YYYY', 'Europe/London');
        const taxYearEnd = moment.tz(endOfTaxYear, 'Do MMMM YYYY', 'Europe/London');

        // Set first payroll week to the first Saturday of the tax year
        let firstPayrollWeekStart = taxYearStart.clone().day(6);
        if (firstPayrollWeekStart.isBefore(taxYearStart)) {
            firstPayrollWeekStart.add(7, 'days');
        }

        const totalWeeksInYear = taxYearEnd.diff(firstPayrollWeekStart, 'weeks') + 1;

        const today = moment.tz('Europe/London');
        let requestedWeekNumber = !isNaN(weekParam) ? weekParam : today.diff(firstPayrollWeekStart, 'weeks') + 1;

        // Clamp week number between 1 and totalWeeksInYear
        if (requestedWeekNumber < 1) requestedWeekNumber = 1;
        if (requestedWeekNumber > totalWeeksInYear) requestedWeekNumber = totalWeeksInYear;

        const payrollWeekStart = firstPayrollWeekStart.clone().add((requestedWeekNumber - 1) * 7, 'days');
        const endDate = payrollWeekStart.clone().add(6, 'days');

        const previousWeek = requestedWeekNumber === 1 ? totalWeeksInYear : requestedWeekNumber - 1;
        const previousYear = requestedWeekNumber === 1 ? year - 1 : year;
        const nextWeek = requestedWeekNumber === totalWeeksInYear ? 1 : requestedWeekNumber + 1;
        const nextYear = requestedWeekNumber === totalWeeksInYear ? year + 1 : year;

        const {
            attendanceRecords,
            employeeCount,
            subcontractorCount,
            allEmployees,
            allSubcontractors,
            paidReceipts
        } = await attendanceService.getAttendanceForWeek(payrollWeekStart, endDate);

        const {
            groupedAttendance,
            totalEmployeeHours,
            totalEmployeePay,
            totalSubcontractorPay,
            daysOfWeek
        } = attendanceService.groupAttendanceByPerson(
            attendanceRecords,
            payrollWeekStart,
            endDate,
            allEmployees,
            allSubcontractors,
            paidReceipts
        );

        res.render(path.join('attendance', 'weekly'), {
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
            currentTab: 'weekly',
            daysOfWeek,
        });
    } catch (error) {
        logger.error('Error fetching weekly attendance: ' + error.message);
        req.flash('error', 'Error fetching weekly attendance: ' + error.message);
        next(error);
    }
};

// Redirect `/attendance/weekly` to the current week's attendance
router.get('/weekly',  authService.ensureRole(), (req, res, next) => {
    try {
        const currentTaxYear = taxService.getCurrentTaxYear();
        const { start: startOfTaxYear, end: endOfTaxYear } = taxService.getTaxYearStartEnd(currentTaxYear);
        const taxYearStart = moment.tz(startOfTaxYear, 'Do MMMM YYYY', 'Europe/London');
        const taxYearEnd = moment.tz(endOfTaxYear, 'Do MMMM YYYY', 'Europe/London');

        let firstPayrollWeekStart = taxYearStart.clone().day(6);
        if (firstPayrollWeekStart.isBefore(taxYearStart)) {
            firstPayrollWeekStart.add(7, 'days');
        }

        const totalWeeksInYear = taxYearEnd.diff(firstPayrollWeekStart, 'weeks') + 1;

        const currentWeekNumber = moment.tz('Europe/London').diff(firstPayrollWeekStart, 'weeks') + 1;
        const safeWeekNumber = Math.min(Math.max(currentWeekNumber, 1), totalWeeksInYear);

        logger.info(`Redirecting to current weekly attendance: Year: ${currentTaxYear}, Week Number: ${safeWeekNumber}`);
        return res.redirect(`/attendance/weekly/${currentTaxYear}/${safeWeekNumber}`);
    } catch (error) {
        logger.error('Error redirecting to current weekly attendance: ' + error.message);
        req.flash('error', 'Error redirecting to current weekly attendance: ' + error.message);
        next(error);
    }
});

router.get('/weekly/:year?/:week?',  authService.ensureRole(), getWeeklyAttendance);

module.exports = router;
