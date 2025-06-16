const moment = require('moment');
const logger = require('../loggerService');
const mdb = require('./mongooseDatabaseService');

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
 * Get attendance + receipts for the week
 */
const getAttendanceForWeek = async (payrollWeekStart, endDate) => {
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
      }).populate('CustomerID') // must link to supplier
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
 * Group attendance and receipts
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
      employeeId: emp._id,
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
        subcontractorId: supplier._id,
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
        employeeId: employee._id,
        subcontractorId: null,
        totalHoursWorked: 0,
        weeklyPay: 0,
        dailyRecords: {},
        type: 'employee'
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

  return {
    groupedAttendance,
    totalEmployeeHours,
    totalEmployeePay,
    totalSubcontractorPay,
    daysOfWeek
  };
};

module.exports = {
  getAttendanceForDay,
  getAttendanceForWeek,
  groupAttendanceByPerson
};
