const moment = require('moment');
const logger = require('../../services/loggerService');
const mdb = require('./mongooseDatabaseService');
const taxService = require('../../services/taxService');

/**
 * Get attendance for a day
 */
const getAttendanceForDay = async (date) => {
  try {
    return await mdb.attendance
      .find({ date })
      .populate('employeeId')
      .populate('locationId')
      .sort({ date: 1 });
  } catch (error) {
    logger.error('Error fetching attendance records: ' + error.message);
    throw new Error('Failed to fetch attendance records for the day');
  }
};

/**
 * Low-level: Fetch attendance + receipts between two dates
 */
const fetchAttendanceForWeek = async (payrollWeekStart, endDate) => {
  try {
    const [attendanceRecords, allEmployees, allSubcontractors, paidReceipts] = await Promise.all([
      mdb.attendance
        .find({
          date: {
            $gte: payrollWeekStart.format('YYYY-MM-DD'),
            $lte: endDate.format('YYYY-MM-DD')
          }
        })
        .populate('employeeId')
        .populate('locationId')
        .sort({ date: 1 }),

      mdb.employee.find({ status: 'active' }),

      mdb.supplier.find({ Subcontractor: true }),

      mdb.receipt.find({
        Paid: true,
        AmountPaid: { $gt: 0 },
        InvoiceDate: {
          $gte: payrollWeekStart.format('YYYY-MM-DD'),
          $lte: endDate.format('YYYY-MM-DD')
        }
      }).populate('CustomerID')
    ]);

    return {
      attendanceRecords,
      employeeCount: allEmployees.length,
      subcontractorCount: allSubcontractors.length,
      allEmployees,
      allSubcontractors,
      paidReceipts
    };
  } catch (error) {
    logger.error('Error fetching attendance week data: ' + error.message);
    throw new Error('Failed to fetch weekly attendance');
  }
};

/**
 * Group attendance and receipts by person
 */
const groupAttendanceByPerson = (
  attendanceRecords,
  payrollWeekStart,
  endDate,
  allEmployees,
  allSubcontractors,
  paidReceipts = []
) => {
  const groupedAttendance = {};
  let totalEmployeeHours = 0;
  let totalSubcontractorPay = 0;

  // Init employees
  allEmployees.forEach(emp => {
    groupedAttendance[emp.name] = {
      employeeId: emp.uuid,
      subcontractorId: null,
      totalHoursWorked: 0,
      weeklyPay: 0,
      dailyRecords: {},
      type: 'employee'
    };
  });

  // Add subcontractors from receipts
  paidReceipts.forEach(receipt => {
    const supplier = receipt.CustomerID;
    if (!supplier) return;

    const name = supplier.Name;
    const dateKey = moment(receipt.InvoiceDate).format('YYYY-MM-DD');
    const amount = parseFloat(receipt.AmountPaid || 0);

    if (!groupedAttendance[name]) {
      groupedAttendance[name] = {
        employeeId: null,
        subcontractorId: supplier.uuid,
        totalHoursWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'subcontractor'
      };
    }

    groupedAttendance[name].weeklyPay += amount;

    if (!groupedAttendance[name].dailyRecords[dateKey]) {
      groupedAttendance[name].dailyRecords[dateKey] = {};
    }

    groupedAttendance[name].dailyRecords[dateKey][`receipt-${receipt._id}`] = {
      location: null,
      type: 'Receipt',
      hoursWorked: null,
      weeklyPay: amount
    };

    totalSubcontractorPay += amount;
  });

  // Add employee attendance
  attendanceRecords.forEach(record => {
    const employee = record.employeeId;
    if (!employee) return;

    const name = employee.name;
    const dateKey = moment(record.date).format('YYYY-MM-DD');
    const hoursWorked = parseFloat(record.hoursWorked || 0);
    const hourlyRate = parseFloat(employee.hourlyRate || 0);
    const calculatedPay = hoursWorked * hourlyRate;

    if (!groupedAttendance[name]) {
      groupedAttendance[name] = {
        employeeId: employee.uuid,
        subcontractorId: null,
        totalHoursWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'employee',
        status: emp.status
      };
    }

    if (!groupedAttendance[name].dailyRecords[dateKey]) {
      groupedAttendance[name].dailyRecords[dateKey] = {};
    }

    groupedAttendance[name].dailyRecords[dateKey][record._id] = {
      location: record.locationId || null,
      type: record.type,
      hoursWorked,
      weeklyPay: calculatedPay
    };

    groupedAttendance[name].totalHoursWorked += hoursWorked;
    groupedAttendance[name].weeklyPay += calculatedPay;
    totalEmployeeHours += hoursWorked;
  });

  // Build day list
  const daysOfWeek = Array.from({ length: 7 }, (_, i) =>
    payrollWeekStart.clone().add(i, 'days').format('YYYY-MM-DD')
  );

  const totalEmployeePay = Object.values(groupedAttendance)
    .filter(e => e.employeeId)
    .reduce((sum, p) => sum + p.weeklyPay, 0);

  const totalSubcontractorDays = Object.values(groupedAttendance)
    .filter(e => e.type === 'subcontractor')
    .reduce((sum, e) => sum + Object.keys(e.dailyRecords).length, 0);

  return {
    groupedAttendance,
    totalEmployeeHours,
    totalEmployeePay,
    totalSubcontractorPay,
    totalSubcontractorDays,
    daysOfWeek
  };
};


/**
 * High-level week fetcher
 */
const getAttendanceForWeek = async (yearParam, weekParam) => {
  const year = !isNaN(yearParam) ? yearParam : taxService.getCurrentTaxYear();
  const { start: startOfTaxYear, end: endOfTaxYear } = taxService.getTaxYearStartEnd(year);

  const taxYearStart = moment.tz(startOfTaxYear, 'Do MMMM YYYY', 'Europe/London');
  const taxYearEnd = moment.tz(endOfTaxYear, 'Do MMMM YYYY', 'Europe/London');

  let firstPayrollWeekStart = taxYearStart.clone().day(6);
  if (firstPayrollWeekStart.isBefore(taxYearStart)) firstPayrollWeekStart.add(7, 'days');

  const totalWeeksInYear = taxYearEnd.diff(firstPayrollWeekStart, 'weeks') + 1;

  const today = moment.tz('Europe/London');
  let requestedWeekNumber = !isNaN(weekParam)
    ? weekParam
    : today.diff(firstPayrollWeekStart, 'weeks') + 1;

  requestedWeekNumber = Math.max(1, Math.min(requestedWeekNumber, totalWeeksInYear));

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
  } = await fetchAttendanceForWeek(payrollWeekStart, endDate);

  const {
    groupedAttendance,
    totalEmployeeHours,
    totalEmployeePay,
    totalSubcontractorPay,
    totalSubcontractorDays,
    daysOfWeek
  } = groupAttendanceByPerson(attendanceRecords, payrollWeekStart, endDate, allEmployees, allSubcontractors, paidReceipts);

  const activeJobs = await mdb.job.find({
    startDate: { $lte: endDate.toDate() },
    $or: [{ endDate: null }, { endDate: { $gte: payrollWeekStart.toDate() } }],
    status: { $ne: 'archived' }
  }).populate('projectId').populate('locationId').lean();

  return {
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
    daysOfWeek,
    activeJobs
  };
};

module.exports = {
  getAttendanceForDay,
  fetchAttendanceForWeek,
  getAttendanceForWeek,
  groupAttendanceByPerson
};
