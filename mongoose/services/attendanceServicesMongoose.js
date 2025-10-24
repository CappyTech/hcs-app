const moment = require('moment');
const logger = require('../../services/loggerService');
const mdb = require('./mongooseDatabaseService');
const taxService = require('../../services/taxService');

/**
 * Get attendance for a day
 */
const getAttendanceForDay = async (date) => {
  try {
    // Normalize date to day boundaries
    const start = moment(date).startOf('day').toDate();
    const end = moment(date).endOf('day').toDate();
    return await mdb.INTERNAL.attendance
      .find({ date: { $gte: start, $lte: end } })
      .populate('employeeId')
      .populate('locationId')
      .sort({ date: 1 });
  } catch (error) {
    logger.error('Error fetching attendance records: ' + error.message);
    throw new Error('Failed to fetch attendance records for the day');
  }
};

/**
 * Low-level: Fetch attendance + purchases between two dates
 */
const fetchAttendanceForWeek = async (payrollWeekStart, endDate) => {
  try {
    const start = payrollWeekStart.clone().startOf('day').toDate();
    const end = endDate.clone().endOf('day').toDate();

    // Fetch internal attendance records for the week
    const attendancePromise = mdb.INTERNAL.attendance
      .find({ date: { $gte: start, $lte: end } })
      .populate('employeeId')
      .populate('locationId')
      .populate('contractAssignmentId')
      .sort({ date: 1 });

    // Active employees (INTERNAL)
    const activeEmployeesPromise = mdb.INTERNAL.employee.find({ status: 'active' });

    // Subcontractors (REST)
  const subcontractorsPromise = mdb.REST.supplier.find({ $or: [{ Subcontractor: true }, { IsSubcontractor: true }] });

    // Purchases with payments within the week (REST)
    const purchasesPromise = mdb.REST.purchase.find({
      $or: [
        { PaidDate: { $gte: start, $lte: end } },
        { PaymentLines: { $elemMatch: { $or: [{ PayDate: { $gte: start, $lte: end } }, { Date: { $gte: start, $lte: end } }] } } }
      ]
    }).select('uuid SupplierId SupplierName SupplierReference Number TotalPaidAmount PaidDate PaymentLines deletedAt');

    const [attendanceRecords, allEmployees, allSubcontractors, purchases] = await Promise.all([
      attendancePromise,
      activeEmployeesPromise,
      subcontractorsPromise,
      purchasesPromise
    ]);

    // Limit purchases to suppliers that are subcontractors
    // and exclude soft-deleted ones with a robust check
    const isSoftDeleted = (doc) => {
      const d = doc && doc.deletedAt;
      if (d === undefined || d === null) return false;
      if (typeof d === 'string' && (d.trim() === '' || d.trim() === '0000-00-00 00:00:00')) return false;
      return !!d;
    };

    const purchasesNotDeleted = (purchases || []).filter(p => !isSoftDeleted(p));
    if (process.env.DEBUG) {
      logger.info(`[weekly] purchases fetched=${(purchases||[]).length}, notDeleted=${purchasesNotDeleted.length}`);
    }
      // Collect supplierIds from purchases first
      const supplierIds = [...new Set(purchasesNotDeleted.map(p => p.SupplierId).filter(id => id != null))];
      const suppliers = supplierIds.length
        ? await mdb.REST.supplier.find({ Id: { $in: supplierIds } }).select('Id Name uuid Subcontractor IsSubcontractor').lean()
        : [];
      // Build allowed subcontractor id set using tolerant truthiness
      const isSubbie = (s) => s && (s.Subcontractor === true || s.IsSubcontractor === true || s.Subcontractor === 1 || s.IsSubcontractor === 1 || s.Subcontractor === 'true' || s.IsSubcontractor === 'true');
      const allowedSubcontractorIds = new Set(suppliers.filter(isSubbie).map(s => s.Id));
      const filteredPurchases = purchasesNotDeleted.filter(p => p && allowedSubcontractorIds.has(p.SupplierId));
      if (process.env.DEBUG) {
        logger.info(`[weekly] subcontractors=${allowedSubcontractorIds.size}, filteredPurchases=${filteredPurchases.length}`);
      }
      const supplierById = new Map(suppliers.map(s => [s.Id, s]));

    // Derive paid purchases as payment events within the week
    const startMs = start.getTime();
    const endMs = end.getTime();
    const inRange = (dateLike) => {
      if (!dateLike) return false;
      const t = new Date(dateLike).getTime();
      return !isNaN(t) && t >= startMs && t <= endMs;
    };

    const buildEventsForPurchase = (p, supplierDoc) => {
      const lines = Array.isArray(p.PaymentLines) ? p.PaymentLines : [];
      const lineEvents = lines
        .map((pl, idx) => ({ pl, idx }))
        .filter(({ pl }) => inRange(pl.PayDate || pl.Date))
        .map(({ pl, idx }) => ({
          _id: `${p.uuid}-pl-${idx}`,
          CustomerID: supplierDoc,
          InvoiceDate: pl.PayDate || pl.Date,
          AmountPaid: Number(pl.Amount || pl.Value || 0),
          InvoiceNumber: p.Number,
          SupplierReference: p.SupplierReference || null,
          PurchaseUuid: p.uuid || null
        }));
      if (lineEvents.length) return lineEvents;
      if (inRange(p.PaidDate) && (p.TotalPaidAmount || 0) > 0) {
        return [{
          _id: `${p.uuid}-hdr`,
          CustomerID: supplierDoc,
          InvoiceDate: p.PaidDate,
          AmountPaid: Number(p.TotalPaidAmount || 0),
          InvoiceNumber: p.Number,
          SupplierReference: p.SupplierReference || null,
          PurchaseUuid: p.uuid || null
        }];
      }
      return [];
    };

    const paidPurchases = filteredPurchases.reduce((acc, p) => {
      const supplierDoc = supplierById.get(p.SupplierId) || { Name: p.SupplierName, uuid: null };
      acc.push(...buildEventsForPurchase(p, supplierDoc));
      return acc;
    }, []);
    if (process.env.DEBUG) logger.info(`[weekly] paidPurchases events=${paidPurchases.length}`);

    return {
      attendanceRecords,
      employeeCount: allEmployees.length,
        subcontractorCount: allowedSubcontractorIds.size,
      allEmployees,
        allSubcontractors: suppliers.filter(isSubbie),
      paidPurchases
    };
  } catch (error) {
    logger.error('Error fetching attendance week data: ' + error.message);
    throw new Error('Failed to fetch weekly attendance');
  }
};

/**
 * Group attendance and purchases by person
 */
const groupAttendanceByPerson = (
  attendanceRecords,
  payrollWeekStart,
  endDate,
  allEmployees,
  allSubcontractors,
  paidPurchases = []
) => {
  const groupedAttendance = {};
  let totalEmployeeHours = 0;
  let totalSubcontractorPay = 0;

  // Init employees
  allEmployees.forEach(emp => {
    groupedAttendance[emp.name] = {
      name: emp.name,
      employeeId: emp.uuid,
      subcontractorId: null,
      totalHoursWorked: 0,
      weeklyPay: 0,
      dailyRecords: {},
      type: 'employee'
    };
  });

  // Add subcontractors from purchases
  paidPurchases.forEach(purchase => {
    const supplier = purchase.CustomerID;
    if (!supplier) return;

    const name = supplier.Name;
    const dateKey = moment(purchase.InvoiceDate).format('YYYY-MM-DD');
    const amount = parseFloat(purchase.AmountPaid || 0);

    if (!groupedAttendance[name]) {
      groupedAttendance[name] = {
        name,
        employeeId: null,
        subcontractorId: supplier.uuid,
        totalDaysWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'subcontractor'
      };
    }

    groupedAttendance[name].weeklyPay += amount;

    if (!groupedAttendance[name].dailyRecords[dateKey]) {
      groupedAttendance[name].dailyRecords[dateKey] = {};
    }

    groupedAttendance[name].dailyRecords[dateKey][`purchase-${purchase._id}`] = {
      location: null,
      type: 'Purchase',
      hoursWorked: null,
      weeklyPay: amount,
      invoiceNumber: purchase.InvoiceNumber || null,
      supplierReference: purchase.SupplierReference || null,
      purchaseUuid: purchase.PurchaseUuid || null
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
        status: employee.status
      };
    }

    if (!groupedAttendance[name].dailyRecords[dateKey]) {
      groupedAttendance[name].dailyRecords[dateKey] = {};
    }

    groupedAttendance[name].dailyRecords[dateKey][record._id] = {
      uuid: record.uuid,
      location: record.locationId || null,
      type: record.type,
      hoursWorked,
      weeklyPay: calculatedPay,
      contractAssignmentId: record.contractAssignmentId || null
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
    paidPurchases
  } = await fetchAttendanceForWeek(payrollWeekStart, endDate);

  const {
    groupedAttendance,
    totalEmployeeHours,
    totalEmployeePay,
    totalSubcontractorPay,
    totalSubcontractorDays,
    daysOfWeek
  } = groupAttendanceByPerson(attendanceRecords, payrollWeekStart, endDate, allEmployees, allSubcontractors, paidPurchases);

  // INTERNAL.job was replaced with REST.project — surface "active jobs" from active REST projects
  let activeJobs = [];
  try {
    const projects = await mdb.REST.project.find({
      deletedAt: null,
      Status: { $in: ['Active', 'In Progress', 'Pending'] }
    }).select('Number Name Reference Status').sort({ Number: 1 }).lean();

    // Shape to match the existing view expectations: jobRef, projectId, locationId
    activeJobs = projects.map(p => ({
      jobRef: p.Number || p.Reference || p.Name,
      projectId: p, // view reads projectId.Name || projectId.Reference
      locationId: null
    }));
  } catch (e) {
    logger.warn('Active projects lookup skipped: ' + e.message);
    activeJobs = [];
  }

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
