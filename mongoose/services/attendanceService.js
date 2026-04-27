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
      .populate('subcontractorId')
      .populate('locationId')
      .populate('projectId')
      .populate('contractAssignmentId')
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
      .populate('subcontractorId')
      .populate('locationId')
      .populate('contractAssignmentId')
      .sort({ date: 1 });

    // Active employees (INTERNAL)
    const activeEmployeesPromise = mdb.INTERNAL.employee.find({ status: 'active' });

    // Subcontractors (REST) — match CIS dashboard: require HMRC verification number
    const VERIFICATION_REGEX = /^V\d{7,10}(\/[A-Z]{1,2})?$/;
    const subcontractorsPromise = mdb.REST.supplier.find({
      WithholdingTaxReferences: {
        $elemMatch: {
          Name: 'Verification Number',
          Value: { $regex: VERIFICATION_REGEX }
        }
      }
    });

    // Purchases with payments or due dates within the week (REST)
    const purchasesPromise = mdb.REST.purchase.find({
      $or: [
        { PaidDate: { $gte: start, $lte: end } },
        { DueDate: { $gte: start, $lte: end } },
        { PaymentLines: { $elemMatch: { $or: [{ PayDate: { $gte: start, $lte: end } }, { Date: { $gte: start, $lte: end } }] } } }
      ]
    }).select('uuid SupplierId SupplierName SupplierReference Number TotalPaidAmount PaidDate DueDate PaymentLines deletedAt NetAmount GrossAmount');

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
        ? await mdb.REST.supplier.find({
            Id: { $in: supplierIds },
            WithholdingTaxReferences: {
              $elemMatch: {
                Name: 'Verification Number',
                Value: { $regex: VERIFICATION_REGEX }
              }
            }
          }).select('Id Name uuid WithholdingTaxRate WithholdingTaxReferences').lean()
        : [];
      const allowedSubcontractorIds = new Set(suppliers.map(s => s.Id));
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
      const events = [];

      // Payment-based events (paid this week)
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
          PurchaseUuid: p.uuid || null,
          paymentStatus: 'paid'
        }));
      if (lineEvents.length) {
        events.push(...lineEvents);
      } else if (inRange(p.PaidDate) && (p.TotalPaidAmount || 0) > 0) {
        events.push({
          _id: `${p.uuid}-hdr`,
          CustomerID: supplierDoc,
          InvoiceDate: p.PaidDate,
          AmountPaid: Number(p.TotalPaidAmount || 0),
          InvoiceNumber: p.Number,
          SupplierReference: p.SupplierReference || null,
          PurchaseUuid: p.uuid || null,
          paymentStatus: 'paid'
        });
      }

      // Due-date event (due this week — independent of payment events)
      if (inRange(p.DueDate)) {
        const amount = Number(p.NetAmount || p.GrossAmount || p.TotalPaidAmount || 0);
        if (amount > 0) {
          events.push({
            _id: `${p.uuid}-due`,
            CustomerID: supplierDoc,
            InvoiceDate: p.DueDate,
            AmountPaid: amount,
            InvoiceNumber: p.Number,
            SupplierReference: p.SupplierReference || null,
            PurchaseUuid: p.uuid || null,
            paymentStatus: 'due'
          });
        }
      }

      return events;
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
      subcontractorCount: allSubcontractors.length,
      allEmployees,
      allSubcontractors, // all verified subcontractors, not just those with purchases this week
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
      employeeMongoId: emp._id,
      department: emp.department || null,
      subcontractorId: null,
      totalHoursWorked: 0,
      weeklyPay: 0,
      dailyRecords: {},
      type: 'employee'
    };
  });

  // Init subcontractors — ensures a row exists even if no purchases fall in this week
  (allSubcontractors || []).forEach(sup => {
    if (!groupedAttendance[sup.Name]) {
      groupedAttendance[sup.Name] = {
        name: sup.Name,
        employeeId: null,
        employeeMongoId: null,
        subcontractorId: sup.uuid,
        totalDaysWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'subcontractor'
      };
    }
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
      purchaseUuid: purchase.PurchaseUuid || null,
      paymentStatus: purchase.paymentStatus || 'paid'
    };

    totalSubcontractorPay += amount;
  });

  // Add subcontractor attendance records (created via inline edit)
  attendanceRecords.forEach(record => {
    if (record.employeeId) return; // handled separately below
    const supplier = record.subcontractorId;
    if (!supplier) return;

    const name = supplier.Name;
    const dateKey = moment(record.date).format('YYYY-MM-DD');
    const dayRate = parseFloat(record.dayRate || 0);

    if (!groupedAttendance[name]) {
      groupedAttendance[name] = {
        name,
        employeeId: null,
        employeeMongoId: null,
        subcontractorId: supplier.uuid,
        totalDaysWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'subcontractor'
      };
    }

    if (!groupedAttendance[name].dailyRecords[dateKey]) {
      groupedAttendance[name].dailyRecords[dateKey] = {};
    }

    groupedAttendance[name].dailyRecords[dateKey][record._id] = {
      uuid: record.uuid,
      location: record.locationId || null,
      type: record.type,
      status: record.status || 'pending',
      hoursWorked: parseFloat(record.hoursWorked || 0) || null,
      dayRate: dayRate || null,
      weeklyPay: dayRate,
      contractId: record.contractId ? String(record.contractId) : null,
      projectId: record.projectId ? String(record.projectId) : null,
      contractAssignmentId: record.contractAssignmentId || null
    };

    groupedAttendance[name].weeklyPay += dayRate;
    if (dayRate > 0) groupedAttendance[name].totalDaysWorked = (groupedAttendance[name].totalDaysWorked || 0) + 1;
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
        name,
        employeeId: employee.uuid,
        employeeMongoId: employee._id,
        department: employee.department || null,
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
      status: record.status || 'approved',
      hoursWorked,
      weeklyPay: calculatedPay,
      contractId: record.contractId ? String(record.contractId) : null,
      projectId: record.projectId ? String(record.projectId) : null,
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

  // ── Management summary stats ──────────────────────────────────────
  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  const typeBreakdown = {}; // { work: N, sick: N, ... }
  const dailyHeadcount = {}; // { 'YYYY-MM-DD': N }

  Object.values(groupedAttendance).forEach(person => {
    Object.entries(person.dailyRecords).forEach(([day, records]) => {
      Object.values(records).forEach(rec => {
        // Count statuses (employee attendance only, purchases have no status)
        if (rec.status === 'pending') pendingCount++;
        else if (rec.status === 'rejected') rejectedCount++;
        else if (rec.status) approvedCount++;

        // Type breakdown
        const t = rec.type || 'unknown';
        typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
      });
      // Headcount: count unique people present per day
      if (Object.keys(records).length > 0) {
        dailyHeadcount[day] = (dailyHeadcount[day] || 0) + 1;
      }
    });
  });

  return {
    groupedAttendance,
    totalEmployeeHours,
    totalEmployeePay,
    totalSubcontractorPay,
    totalSubcontractorDays,
    daysOfWeek,
    pendingCount,
    approvedCount,
    rejectedCount,
    typeBreakdown,
    dailyHeadcount
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
    daysOfWeek,
    pendingCount,
    approvedCount,
    rejectedCount,
    typeBreakdown,
    dailyHeadcount
  } = groupAttendanceByPerson(attendanceRecords, payrollWeekStart, endDate, allEmployees, allSubcontractors, paidPurchases);

  // INTERNAL contracts — surfaced instead of REST projects for inline cell editor
  let activeContracts = [];
  try {
    activeContracts = await mdb.INTERNAL.contract
      .find({ status: { $in: ['Planned', 'In Progress'] } })
      .select('_id uuid title location status')
      .sort({ title: 1 })
      .lean();
  } catch (e) {
    logger.warn('Active contracts lookup skipped: ' + e.message);
    activeContracts = [];
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
    totalSubcontractorDays,
    daysOfWeek,
    activeProjects: activeContracts, // kept for backward compat with other views that read activeProjects
    activeContracts,
    projectStatusFilter: ['Planned', 'In Progress'],
    taxWeekNumber: requestedWeekNumber,
    taxYear: year,
    pendingCount,
    approvedCount,
    rejectedCount,
    typeBreakdown,
    dailyHeadcount
  };
};

/**
 * Fetch Paperless statements and their linked purchases for a given week.
 *
 * A "statement" is an OcrDocument with documentType.name === "statement" and a
 * custom field "Invoice Numbers" (comma-separated). Each invoice number is
 * matched against REST purchases by their Number field.
 *
 * Returns an array of statement objects, each containing the OcrDocument and
 * the matched purchases.
 */
const fetchStatementsForWeek = async (payrollWeekStart, endDate) => {
  if (!mdb.PAPERLESS || !mdb.PAPERLESS.OcrDocument) return [];

  const start = payrollWeekStart.clone().startOf('day').toDate();
  const end = endDate.clone().endOf('day').toDate();

  // Find statements whose DueDate (from custom field "Invoice Due Date") falls
  // within or overlaps the week, or that were created/modified this week.
  // We fetch broadly and filter client-side to keep the query simple.
  const statements = await mdb.PAPERLESS.OcrDocument.find({
    'documentType.name': 'statement',
    modified: { $gte: start, $lte: end }
  }).lean();

  if (!statements.length) return [];

  // Extract all invoice numbers and statement totals
  const statementData = statements.map(stmt => {
    const invoiceField = (stmt.customFields || []).find(
      cf => cf.fieldName === 'Invoice Number'
    );
    const totalField = (stmt.customFields || []).find(
      cf => cf.fieldName === 'Invoice Total'
    );
    const raw = invoiceField ? String(invoiceField.value || '') : '';
    const invoiceNumbers = raw
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);
    // Parse "GBP108.93" or plain "108.93" → number
    const statementTotal = totalField
      ? parseFloat(String(totalField.value || '').replace(/[^0-9.\-]/g, '')) || 0
      : 0;
    return { statement: stmt, invoiceNumbers, statementTotal };
  });

  // Collect unique invoice numbers across all statements
  const allInvoiceNumbers = [...new Set(
    statementData.flatMap(d => d.invoiceNumbers)
  )];

  if (!allInvoiceNumbers.length) return statementData;

  // Fetch matching purchases from REST
  const purchases = await mdb.REST.purchase.find({
    Number: { $in: allInvoiceNumbers }
  }).select(
    'uuid Number SupplierId SupplierName SupplierReference GrossAmount NetAmount ' +
    'TotalPaidAmount PaidDate DueDate deletedAt'
  ).lean();

  const purchaseByNumber = new Map();
  for (const p of purchases) {
    purchaseByNumber.set(String(p.Number), p);
  }

  // Attach matched purchases to each statement
  for (const entry of statementData) {
    entry.purchases = entry.invoiceNumbers
      .map(num => purchaseByNumber.get(num) || null)
      .filter(Boolean);
    entry.missingNumbers = entry.invoiceNumbers
      .filter(num => !purchaseByNumber.has(num));
    entry.totalGross = entry.purchases.reduce(
      (sum, p) => sum + Number(p.GrossAmount || p.NetAmount || 0), 0
    );
    entry.totalPaid = entry.purchases.reduce(
      (sum, p) => sum + Number(p.TotalPaidAmount || 0), 0
    );
    entry.totalOutstanding = entry.totalGross - entry.totalPaid;
  }

  // Resolve supplier contact details for each statement from its correspondent
  // or from the first matched purchase's SupplierId
  const supplierIds = [...new Set(
    statementData.flatMap(d =>
      (d.purchases || []).map(p => p.SupplierId).filter(id => id != null)
    )
  )];
  const suppliers = supplierIds.length
    ? await mdb.REST.supplier.find({ Id: { $in: supplierIds } })
        .select('Id Name Code Contacts Address')
        .lean()
    : [];
  const supplierById = new Map(suppliers.map(s => [s.Id, s]));

  for (const entry of statementData) {
    const firstSupplierId = (entry.purchases[0] || {}).SupplierId;
    entry.supplier = firstSupplierId ? supplierById.get(firstSupplierId) || null : null;
  }

  return statementData;
};

module.exports = {
  getAttendanceForDay,
  fetchAttendanceForWeek,
  getAttendanceForWeek,
  groupAttendanceByPerson,
  fetchStatementsForWeek
};
