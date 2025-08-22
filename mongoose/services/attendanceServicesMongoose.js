const moment = require('moment-timezone');
const logger = require('../../services/loggerService');
const mdb = require('./mongooseDatabaseService');
const taxService = require('../../services/taxService');

/**
 * Get attendance for a day
 */
const getAttendanceForDay = async (date) => {
  try {
    return await mdb.INTERNAL.attendance
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
      mdb.INTERNAL.attendance
        .find({
          date: {
            $gte: payrollWeekStart.format('YYYY-MM-DD'),
            $lte: endDate.format('YYYY-MM-DD')
          }
        })
        .populate('employeeId')
        .populate('locationId')
        .populate('contractAssignmentId')
        .sort({ date: 1 }),

      mdb.INTERNAL.employee.find({ status: 'active' }),

      mdb.REST.supplier.find({ IsSubcontractor: true }),

      mdb.REST.purchase.find({
        Paid: true,
        AmountPaid: { $gt: 0 },
        InvoiceDate: {
          $gte: payrollWeekStart.format('YYYY-MM-DD'),
          $lte: endDate.format('YYYY-MM-DD')
        }
      })
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

  const supplierMap = new Map(allSubcontractors.map(s => [s.SupplierID, s]));

  // Init employees
  allEmployees.forEach(emp => {
    groupedAttendance[emp.uuid] = {
      name: emp.name,
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
    const supplier = supplierMap.get(receipt.CustomerID);
    if (!supplier) {
      logger.warn(`No supplier found for receipt with CustomerID ${receipt.CustomerID}`);
      return;
    }

    const subcontractorKey = supplier.uuid;
    const displayName = supplier.Name || supplier.Code || `Subcontractor ${subcontractorKey}`;
    const dateKey = moment(receipt.InvoiceDate).format('YYYY-MM-DD');
    const amount = parseFloat(receipt.AmountPaid || 0);

    if (!groupedAttendance[subcontractorKey]) {
      groupedAttendance[subcontractorKey] = {
        name: displayName,
        employeeId: null,
        subcontractorId: subcontractorKey,
        totalHoursWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'subcontractor'
      };
    }

    groupedAttendance[subcontractorKey].weeklyPay += amount;

    if (!groupedAttendance[subcontractorKey].dailyRecords[dateKey]) {
      groupedAttendance[subcontractorKey].dailyRecords[dateKey] = {};
    }

    groupedAttendance[subcontractorKey].dailyRecords[dateKey][`receipt-${receipt.uuid}`] = {
      location: null,
      type: 'Receipt',
      number: receipt.InvoiceNumber || null,
      hoursWorked: null,
      weeklyPay: amount
    };

    totalSubcontractorPay += amount;
  });

  // Add employee attendance
  attendanceRecords.forEach(record => {
    const employee = record.employeeId;
    if (!employee) return;

    const employeeKey = employee.uuid;
    const dateKey = moment(record.date).format('YYYY-MM-DD');
    const hoursWorked = parseFloat(record.hoursWorked || 0);
    const hourlyRate = parseFloat(employee.hourlyRate || 0);
    const calculatedPay = hoursWorked * hourlyRate;

    if (!groupedAttendance[employeeKey]) {
      groupedAttendance[employeeKey] = {
        name: employee.name,
        employeeId: employee.uuid,
        subcontractorId: null,
        totalHoursWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'employee',
        status: employee.status
      };
    }

    if (!groupedAttendance[employeeKey].dailyRecords[dateKey]) {
      groupedAttendance[employeeKey].dailyRecords[dateKey] = {};
    }

    groupedAttendance[employeeKey].dailyRecords[dateKey][record.uuid] = {
      uuid: record.uuid,
      location: record.locationId || null,
      type: record.type,
      hoursWorked,
      weeklyPay: calculatedPay,
      contractAssignmentId: record.contractAssignmentId || null
    };

    groupedAttendance[employeeKey].totalHoursWorked += hoursWorked;
    groupedAttendance[employeeKey].weeklyPay += calculatedPay;
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

  // Fetch active contracts without populating projectId (project model lives in REST DB)
  const activeJobs = await mdb.INTERNAL.contract.find({
    startDate: { $lte: endDate.toDate() },
    $or: [{ endDate: null }, { endDate: { $gte: payrollWeekStart.toDate() } }],
    status: { $ne: 'archived' }
  }).populate('locationId').lean();

  // Manually join project documents from REST DB
  const projectIdSet = new Set(
    activeJobs
      .filter(j => j.projectId)
      .map(j => String(j.projectId))
  );
  let projectMap = {};
  if (projectIdSet.size) {
    const projects = await mdb.REST.project.find({ _id: { $in: Array.from(projectIdSet) } })
      .select('Name Reference Number uuid')
      .lean();
    projectMap = Object.fromEntries(projects.map(p => [String(p._id), p]));
  }
  // Replace projectId ObjectId with the project doc (maintains template expectations job.projectId.Name)
  activeJobs.forEach(job => {
    if (job.projectId) {
      const proj = projectMap[String(job.projectId)];
      if (proj) {
        job.projectId = proj; // preserve existing view field usage
      }
    }
  });

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
