import { format } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import logger from '../../services/loggerService.js';
import mdb from './mongooseDatabaseService.js';
import taxService from '../../services/taxService.js';
import { HMRC_VERIFICATION_REGEX } from '../../services/cisService.js';

const TZ = 'Europe/London';

// Accept Date, moment-like (has valueOf), number or string inputs
const toDateAny = (x) =>
  x instanceof Date ? x : new Date(typeof x?.valueOf === 'function' ? x.valueOf() : x);

/** London wall-clock date string (yyyy-MM-dd) of an instant. */
const londonYMD = (instant) => formatInTimeZone(toDateAny(instant), TZ, 'yyyy-MM-dd');
/** Instant of London midnight on the same London calendar day. */
const londonMidnight = (instant) => fromZonedTime(londonYMD(instant), TZ);
/** Instant of London 23:59:59.999 on the same London calendar day. */
const londonEndOfDay = (instant) => fromZonedTime(`${londonYMD(instant)}T23:59:59.999`, TZ);
/** Add whole London calendar days (DST-safe wall-time arithmetic). */
const addLondonDays = (instant, days) => {
  const d = new Date(`${londonYMD(instant)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return fromZonedTime(d.toISOString().slice(0, 10), TZ);
};

/**
 * Get attendance for a day
 */
const getAttendanceForDay = async (date) => {
  try {
    // Normalize date to (server-local) day boundaries
    const start = toDateAny(date);
    start.setHours(0, 0, 0, 0);
    const end = toDateAny(date);
    end.setHours(23, 59, 59, 999);
    return await mdb.INTERNAL.attendance
      .find({ date: { $gte: start, $lte: end } })
      .populate('employeeId')
      .populate('subcontractorId')
      .populate('locationId')
      .populate('projectId')
      .populate('contractAssignmentId')
      .sort({ date: 1 });
  } catch (error) {
    logger.error(`[attendanceService] Error fetching attendance records: ${error.message}`, { stack: error.stack });
    throw new Error('Failed to fetch attendance records for the day');
  }
};

/**
 * Low-level: Fetch attendance + purchases between two dates
 */
const fetchAttendanceForWeek = async (payrollWeekStart, endDate) => {
  try {
    const start = londonMidnight(payrollWeekStart);
    const end = londonEndOfDay(endDate);

    // Fetch internal attendance records for the week
    const attendancePromise = mdb.INTERNAL.attendance
      .find({ date: { $gte: start, $lte: end } })
      .populate('employeeId')
      .populate('subcontractorId')
      .populate('locationId')
      .populate('contractId')
      .populate('contractAssignmentId')
      .sort({ date: 1 });

    // Active employees (INTERNAL)
    const activeEmployeesPromise = mdb.INTERNAL.employee.find({ status: 'active' });

    // Subcontractors (REST) — match CIS dashboard: require HMRC verification number
    const subcontractorsPromise = mdb.REST.supplier.find({
      WithholdingTaxReferences: {
        $elemMatch: {
          Name: 'Verification Number',
          Value: { $regex: HMRC_VERIFICATION_REGEX }
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
                Value: { $regex: HMRC_VERIFICATION_REGEX }
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
    logger.error(`[attendanceService] Error fetching attendance week data: ${error.message}`, { stack: error.stack });
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
    const dateKey = format(toDateAny(purchase.InvoiceDate), 'yyyy-MM-dd');
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
    const dateKey = format(toDateAny(record.date), 'yyyy-MM-dd');
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
    const dateKey = format(toDateAny(record.date), 'yyyy-MM-dd');
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

  // Build day list (London calendar days)
  const daysOfWeek = Array.from({ length: 7 }, (_, i) =>
    londonYMD(addLondonDays(payrollWeekStart, i))
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
      // Headcount: count unique employees present per day (not subcontractors/purchases)
      if (person.type === 'employee' && Object.keys(records).length > 0) {
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

  // First payroll week starts on the Saturday of the week containing 6 April
  const isoDow = Number(formatInTimeZone(startOfTaxYear, TZ, 'i')); // 1=Mon .. 7=Sun
  const deltaToSaturday = isoDow === 7 ? 6 : 6 - isoDow;
  let firstPayrollWeekStart = addLondonDays(startOfTaxYear, deltaToSaturday);
  if (firstPayrollWeekStart.getTime() < startOfTaxYear.getTime()) {
    firstPayrollWeekStart = addLondonDays(firstPayrollWeekStart, 7);
  }

  const WEEK_MS = 7 * 86400000;
  const totalWeeksInYear =
    Math.trunc((endOfTaxYear.getTime() - firstPayrollWeekStart.getTime()) / WEEK_MS) + 1;

  let requestedWeekNumber = !isNaN(weekParam)
    ? weekParam
    : Math.trunc((Date.now() - firstPayrollWeekStart.getTime()) / WEEK_MS) + 1;

  requestedWeekNumber = Math.max(1, Math.min(requestedWeekNumber, totalWeeksInYear));

  const payrollWeekStart = addLondonDays(firstPayrollWeekStart, (requestedWeekNumber - 1) * 7);
  const endDate = addLondonDays(payrollWeekStart, 6);

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
      .select('_id uuid title location status startDate endDate')
      .sort({ title: 1 })
      .lean();
  } catch (e) {
    logger.warn(`[attendanceService] Active contracts lookup skipped: ${e.message}`);
    activeContracts = [];
  }

  // Assignments for this week — grouped under their contract
  const weekAssignments = await fetchAssignmentsForWeek(payrollWeekStart);
  const contractsForWeek = activeContracts.map(c => ({
    contract: c,
    assignments: weekAssignments.filter(a =>
      a.contractId && String(a.contractId._id || a.contractId) === String(c._id)
    )
  }));

  // Vehicle deployments — per-day per-vehicle
  const weekDeployments = await fetchVehicleDeploymentsForWeek(
    londonMidnight(payrollWeekStart),
    londonEndOfDay(endDate)
  );
  const vehicleDeploymentsByVehicleDate = {};
  for (const d of weekDeployments) {
    const vKey = String(d.vehicleId._id || d.vehicleId);
    const dateKey = format(toDateAny(d.date), 'yyyy-MM-dd');
    if (!vehicleDeploymentsByVehicleDate[vKey]) vehicleDeploymentsByVehicleDate[vKey] = {};
    vehicleDeploymentsByVehicleDate[vKey][dateKey] = d;
  }

  // Active fleet for the vehicles table (exclude scrapped/sold)
  let vehicles = [];
  try {
    vehicles = await mdb.INTERNAL.vehicle
      .find({ availabilityStatus: { $ne: 'Disposed' } })
      .select('_id uuid registrationNumber make model bodyType ownershipStatus availabilityStatus ' +
              'roadTaxExpiryDate motExpiryDate insuranceExpiryDate insuranceProvider ' +
              'breakdownExpiryDate breakdownProvider')
      .sort({ registrationNumber: 1 })
      .lean();
  } catch (e) {
    logger.warn(`[attendanceService] Vehicles lookup skipped: ${e.message}`);
  }

  // All REST suppliers (unfiltered) for the assignment cell editor — broader than the
  // CIS-verified allSubcontractors used for the attendance grid.
  let allSuppliersForAssignment = [];
  try {
    allSuppliersForAssignment = await mdb.REST.supplier
      .find({})
      .select('_id uuid Name')
      .sort({ Name: 1 })
      .lean();
  } catch (e) {
    logger.warn(`[attendanceService] allSuppliersForAssignment lookup skipped: ${e.message}`);
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
    dailyHeadcount,
    allEmployees,
    allSubcontractors,
    allSuppliersForAssignment,
    contractsForWeek,
    vehicles,
    vehicleDeploymentsByVehicleDate
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

  const start = londonMidnight(payrollWeekStart);
  const end = londonEndOfDay(endDate);

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

/**
 * Fetch assignments for the week that starts on a given date (Saturday-based payroll week).
 */
const fetchAssignmentsForWeek = async (payrollWeekStart) => {
  try {
    const dayStart = londonMidnight(payrollWeekStart);
    const dayEnd = londonEndOfDay(payrollWeekStart);
    return await mdb.INTERNAL.assignment
      .find({ weekStart: { $gte: dayStart, $lte: dayEnd } })
      .populate('contractId', '_id uuid title location status')
      .populate('assignedEmployees', '_id uuid name department')
      .populate('assignedSubcontractors', '_id uuid Name')
      .sort({ 'contractId.title': 1, title: 1 })
      .lean();
  } catch (e) {
    logger.warn(`[attendanceService] Assignments lookup skipped: ${e.message}`);
    return [];
  }
};

/**
 * Fetch vehicle deployments between two dates.
 */
const fetchVehicleDeploymentsForWeek = async (start, end) => {
  try {
    return await mdb.INTERNAL.vehicleDeployment
      .find({ date: { $gte: start, $lte: end } })
      .populate('vehicleId', '_id uuid registrationNumber make model bodyType')
      .populate('driverEmployeeId', '_id uuid name')
      .populate('driverSubcontractorId', '_id uuid Name')
      .populate('locationId', '_id uuid name')
      .populate('contractId', '_id uuid title location')
      .sort({ date: 1 })
      .lean();
  } catch (e) {
    logger.warn(`[attendanceService] Vehicle deployments lookup skipped: ${e.message}`);
    return [];
  }
};

/**
 * Payroll period locking: once a payroll run covering a date is locked or
 * submitted, non-admin attendance writes for that date are rejected so paid
 * periods can't be silently retro-edited. Returns the blocking run or null.
 */
const getLockedRunForDate = async (date) => {
  const PayrollRun = mdb.INTERNAL?.payrollRun;
  if (!PayrollRun || !date) return null;
  const d = new Date(date);
  if (isNaN(d)) return null;
  return PayrollRun.findOne({
    status: { $in: ['locked', 'submitted'] },
    periodStart: { $lte: d },
    periodEnd: { $gte: d },
  }).select('taxYear taxMonth taxWeek frequency status periodStart periodEnd').lean();
};

export default {
  getAttendanceForDay,
  fetchAttendanceForWeek,
  getAttendanceForWeek,
  groupAttendanceByPerson,
  fetchStatementsForWeek,
  fetchAssignmentsForWeek,
  fetchVehicleDeploymentsForWeek,
  getLockedRunForDate
};

export { getAttendanceForDay, fetchAttendanceForWeek, getAttendanceForWeek, groupAttendanceByPerson, fetchStatementsForWeek, fetchAssignmentsForWeek, fetchVehicleDeploymentsForWeek, getLockedRunForDate };
