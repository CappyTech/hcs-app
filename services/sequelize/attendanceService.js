const moment = require('moment');
const logger = require('../loggerService');
const db = require('./sequelizeDatabaseService');
const kf = require('./kashflowDatabaseService');

const getAttendanceForDay = async (date) => {
    try {
        const attendanceRecords = await db.Attendances.findAll({
            where: { date: date },
            include: [db.Employees, db.Locations], // Removed Subcontractors
            order: [['date', 'ASC']]
        });

        return attendanceRecords;
    } catch (error) {
        logger.error('Error fetching attendance records: ' + error);
        throw new Error('Failed to fetch attendance records for the day');
    }
};

/**
 * Fetch attendance records for a given week.
 * @param {Date} startDate - Start date of the week.
 * @param {Date} endDate - End date of the week.
 * @returns {Promise<Object>} - Attendance records and counts.
 */
const getAttendanceForWeek = async (payrollWeekStart, endDate) => {
    try {
        const attendanceRecords = await db.Attendances.findAll({
            where: {
                date: {
                    [db.Sequelize.Op.between]: [payrollWeekStart.format('YYYY-MM-DD'), endDate.format('YYYY-MM-DD')]
                }
            },
            include: [db.Employees, db.Locations],
            order: [['date', 'ASC']]
        });

        const allEmployees = await db.Employees.findAll({
            where: { status: 'active' }
        });

        // ✅ Get subcontractors first
        const allSubcontractors = await kf.KF_Suppliers.findAll({
            where: { Subcontractor: true }
        });

        const subcontractorIds = allSubcontractors.map(s => s.SupplierID);

        // ✅ Get receipts for just those subcontractors
        const paidReceipts = await kf.KF_Receipts.findAll({
            where: {
                CustomerID: {
                    [kf.Sequelize.Op.in]: subcontractorIds
                },
                Paid: 1,
                AmountPaid: {
                    [kf.Sequelize.Op.gt]: 0
                },
                InvoiceDate: {
                    [kf.Sequelize.Op.between]: [
                        payrollWeekStart.format('YYYY-MM-DD'),
                        endDate.format('YYYY-MM-DD')
                    ]
                }
            },
            include: [{
                model: kf.KF_Suppliers,
                as: 'supplier'
            }]
        });

        return {
            attendanceRecords,
            employeeCount: allEmployees.length,
            subcontractorCount: allSubcontractors.length,
            allEmployees,
            allSubcontractors,
            paidReceipts
        };
    } catch (error) {
        logger.error('Error fetching attendance records: ' + error.message);
        throw new Error('Failed to fetch attendance records for the week');
    }
};


/**
 * Group attendance records by person.
 * @param {Array} attendanceRecords - Array of attendance records.
 * @param {Date} payrollWeekStart - Start date of the week.
 * @param {Array} allEmployees - Array of employees.
 * @returns {Object} - Grouped attendance records.
 */
const groupAttendanceByPerson = (
    attendanceRecords,
    payrollWeekStart,
    endDate, // ✅ Add this
    allEmployees,
    allSubcontractors,
    paidReceipts = []
) => {
    const groupedAttendance = {};
    let totalEmployeeHours = 0;
    let totalSubcontractorPay = 0;

    // ✅ Initialize EMPLOYEES (they always appear)
    allEmployees.forEach(employee => {
        groupedAttendance[employee.name] = {
            employeeId: employee.id,
            subcontractorId: null,
            totalHoursWorked: 0,
            weeklyPay: 0,
            dailyRecords: {},
            type: 'employee' // ✅ Add this
        };
    });

    // ✅ Add subcontractors ONLY if they have paid receipts this week
    paidReceipts.forEach(receipt => {
        const subcontractor = receipt.supplier;
        if (!subcontractor) return;

        const name = subcontractor.Name;
        const dateKey = moment(receipt.InvoiceDate).format('YYYY-MM-DD');
        const amount = parseFloat(receipt.AmountPaid || 0);

        if (!groupedAttendance[name]) {
            groupedAttendance[name] = {
                employeeId: null,
                subcontractorId: subcontractor.SupplierID,
                totalHoursWorked: 0,
                weeklyPay: 0,
                dailyRecords: {},
                type: 'subcontractor' // ✅ Add this
            };
        }

        groupedAttendance[name].weeklyPay += amount;

        if (!groupedAttendance[name].dailyRecords[dateKey]) {
            groupedAttendance[name].dailyRecords[dateKey] = {};
        }

        groupedAttendance[name].dailyRecords[dateKey][`receipt-${receipt.InvoiceDBID}`] = {
            location: null,
            type: 'Receipt',
            hoursWorked: null,
            weeklyPay: amount
        };

        totalSubcontractorPay += amount;
    });

    // ✅ Process ATTENDANCE records (for employees only)
    attendanceRecords.forEach(record => {
        if (!record.Employee) return;

        const personName = record.Employee.name;
        const dateKey = moment(record.date).format('YYYY-MM-DD');
        const hoursWorked = parseFloat(record.hoursWorked) || 0;
        const hourlyRate = parseFloat(record.Employee.hourlyRate) || 0;
        const calculatedPay = hoursWorked * hourlyRate;

        if (!groupedAttendance[personName]) {
            groupedAttendance[personName] = {
                employeeId: record.Employee.id,
                subcontractorId: null,
                totalHoursWorked: 0,
                weeklyPay: 0,
                dailyRecords: {}
            };
        }

        if (!groupedAttendance[personName].dailyRecords[dateKey]) {
            groupedAttendance[personName].dailyRecords[dateKey] = {};
        }

        groupedAttendance[personName].dailyRecords[dateKey][record.id] = {
            location: record.Location,
            type: record.type,
            hoursWorked: hoursWorked,
            weeklyPay: calculatedPay
        };

        groupedAttendance[personName].totalHoursWorked += hoursWorked;
        groupedAttendance[personName].weeklyPay += calculatedPay;
        totalEmployeeHours += hoursWorked;
    });

    // ✅ Build week date list (used in rendering headers)
    const daysOfWeek = [];
    for (let i = 0; i < 7; i++) {
        daysOfWeek.push(payrollWeekStart.clone().add(i, 'days').format('YYYY-MM-DD'));
    }

    // ✅ Calculate total employee pay separately for accuracy
    const totalEmployeePay = Object.values(groupedAttendance)
        .filter(p => p.employeeId)
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
    getAttendanceForWeek,
    groupAttendanceByPerson,
    getAttendanceForDay
};