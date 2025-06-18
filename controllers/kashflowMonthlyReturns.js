const express = require('express');
const router = express.Router();
const logger = require('../services/loggerService');
const path = require('path');
const kf = require('../services/kashflowDatabaseService');
const authService = require('../services/authService');
const slimDateTime = require('../services/dateService').slimDateTime;
const ChargeTypes = require('./CRUD/kashflow/chargeTypes.json');
const normalizePayments = require('../services/kashflowNormalizer').normalizePayments;

const renderKFMonthlyReturnsForm = async (req, res, next) => {
    try {
        
        // Define the monthNames array starting with April as month 1
        const monthNames = [
            'April', 'May', 'June', 'July', 'August', 'September',
            'October', 'November', 'December', 'January', 'February', 'March'
        ];

        // Fetch all suppliers from the database
        const suppliers = await kf.KF_Suppliers.findAll({
            where: {
                Subcontractor: true,
            },
            include: {
                model: kf.KF_Receipts,
                as: 'receipts',
                attributes: ['TaxYear', 'TaxMonth'],
                group: ['TaxYear', 'TaxMonth'],
                order: [
                    ['TaxYear', 'DESC'],
                    ['TaxMonth', 'DESC']
                ]
            },
            order: [
                ['Name', 'ASC']
            ]
        });

        // Modify the suppliers data to group receipts by year and extract unique months
        const suppliersWithMonths = suppliers.map(supplier => {
            const receiptsByYear = {};
            supplier.receipts.forEach(receipt => {
                const year = receipt.TaxYear;
                const month = receipt.TaxMonth;
                if (!receiptsByYear[year]) {
                    receiptsByYear[year] = [];
                }

                if (!receiptsByYear[year].includes(month)) {
                    receiptsByYear[year].push(month);
                    receiptsByYear[year].sort((a, b) => monthNames.indexOf(monthNames[a - 1]) - monthNames.indexOf(monthNames[b - 1]));
                }
            });

            return {
                supplier: supplier,
                years: Object.keys(receiptsByYear).sort((a, b) => b - a),
                receiptsByYear: receiptsByYear,
            };
        });

        // Render the EJS view, passing in the modified subcontractors data
        res.render(path.join('kashflow', 'monthlyReturnsForm'), {
            title: 'Monthly Returns Form',
            suppliersWithMonths: suppliersWithMonths,
            monthNames: monthNames
        });
    } catch (error) {
        logger.error("Error rendering the form: "+ error);
        req.flash('error', 'Error: Unable to render monthly returns');
        const referrer = req.get('referer') || '/';
        res.redirect(referrer);
    }
};

const renderKFMonthlyReturns = async (req, res, next) => {
    try {
        const { month, year, uuid } = req.params;

        if (!month || !year || !uuid) {
            logger.warn("Month, Year and Subcontractor UUID are required.");
            return res.status(400).send("Month, Year and Subcontractor UUID are required.");
        }

        // Extract page break months from query
        const pageBreakMonths = req.query.page
            ? req.query.page.split(',').map(Number)
            : [];

        // Fetch the supplier using UUID
        const supplier = await kf.KF_Suppliers.findOne({ where: { uuid } });
        if (!supplier) {
            logger.warn(`Supplier with UUID ${uuid} not found.`);
            return res.status(404).send("Supplier not found.");
        }

        // Fetch receipts for the given year
        const receipts = await kf.KF_Receipts.findAll({
            where: { CustomerID: supplier.SupplierID, TaxYear: year, TaxMonth: month },
            order: [['InvoiceNumber', 'ASC']]
        });

        // Process receipts to extract details
        const receiptsByMonth = {};

        receipts.forEach(receipt => {
            const month = receipt.TaxMonth || moment.tz(receipt.InvoiceDate, 'Europe/London').month() + 1;

            if (!receiptsByMonth[month]) {
                receiptsByMonth[month] = [];
            }

            // Normalize with parent type awareness
            const normalizedLines = normalizeLines(receipt.Lines, receipt.InvoiceNumber, receipt.CustomerID);
            const normalizedPayments = normalizePayments(receipt.Payments, receipt.InvoiceNumber, receipt.CustomerID);

            // Extract financial values from Lines
            const labourCost = normalizedLines
                .filter(line => line.ChargeType === 18685897)
                .reduce((sum, line) => sum + (parseFloat(line.Rate) * parseFloat(line.Quantity) || 0), 0);

            const materialCost = normalizedLines
                .filter(line => line.ChargeType === 18685896)
                .reduce((sum, line) => sum + (parseFloat(line.Rate) * parseFloat(line.Quantity) || 0), 0);

            const cisAmount = Math.abs(normalizedLines
                .filter(line => line.ChargeType === 18685964)
                .reduce((sum, line) => sum + (parseFloat(line.Rate) * parseFloat(line.Quantity) || 0), 0));

            const grossAmount = labourCost + materialCost;
            const netAmount = grossAmount - cisAmount;

            // Extract payment dates
            const payDates = normalizedPayments?.Payment?.Payment?.map(p => p.PayDate) || [];
            const payDate = payDates.length > 0 ? slimDateTime(payDates[0]) : 'N/A';

            receiptsByMonth[month].push({
                InvoiceNumber: receipt.CustomerReference,
                KashflowNumber: receipt.InvoiceNumber,
                InvoiceDate: receipt.InvoiceDate,
                PayDates: payDates,
                PayDate: payDate,
                GrossAmount: grossAmount,
                LabourCost: labourCost,
                MaterialCost: materialCost,
                CISAmount: cisAmount,
                NetAmount: netAmount,
                SubmissionDate: receipt.SubmissionDate
            });
        });

        res.render(path.join('kashflow', 'monthlyReturnsForOneSubcontractor'), {
            title: 'Subcontractor Monthly Returns',
            year,
            supplier,
            receiptsByMonth,
            monthNames: [
                'April', 'May', 'June', 'July', 'August', 'September',
                'October', 'November', 'December', 'January', 'February', 'March'
            ],
            pageBreakMonths
        });
    } catch (error) {
        logger.error(`Error rendering monthly returns for one subcontractor: ${error.message}`, { stack: error.stack });
        next(error);
    }
};

router.get('/returns/form',  authService.ensureRoles('admin'), renderKFMonthlyReturnsForm);
router.get('/returns/:month/:year/:uuid',  authService.ensureRoles('admin'), renderKFMonthlyReturns);

module.exports = router;