const express = require('express');
const router = express.Router();
const logger = require('../services/loggerService'); 
const path = require('path');
const db = require('../services/sequelizeDatabaseService');
const authService = require('../services/authService');

const renderYearlyReturns = async (req, res, next) => {
    try {
        const { year, id } = req.params;

        if (!year || !id) {
            logger.warn("Year and Subcontractor ID are required.");
            return res.status(400).send("Year and Subcontractor ID are required.");
        }

        const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];

        // Fetch subcontractor data for the given year and ID
        const subcontractor = await db.Subcontractors.findOne({
            where: {
                id: id,
                deletedAt: null
            },
            include: {
                model: db.Invoices,
                as: 'invoices',
                where: {
                    year: year
                },
                order: [
                    ['month', 'ASC']
                ]
            }
        });

        if (!subcontractor) {
            logger.warn("Subcontractor not found.");
            return res.status(404).send("Subcontractor not found.");
        }

        // Extract invoices grouped by month
        const invoicesByMonth = {};
        subcontractor.invoices.forEach(invoice => {
            const month = invoice.month;
            if (!invoicesByMonth[month]) {
                invoicesByMonth[month] = [];
            }
            invoicesByMonth[month].push(invoice);
        });

        logger.info("Rendering yearly returns:", {
            subcontractor: subcontractor,
            year: year,
            invoicesByMonth: invoicesByMonth
        });

        const pageBreakMonths = req.query.page
            ? req.query.page.split(',').map(Number)
            : [];

        res.render(path.join('monthlyreturns', 'yearlyReturns'), {
            title: 'Yearly Returns',
            subcontractor: subcontractor,
            year: year,
            invoicesByMonth: invoicesByMonth,
            monthNames: monthNames,
            pageBreakMonths: pageBreakMonths
        });
    } catch (error) {
        logger.error("Error rendering yearly returns: "+ error.message);
        res.status(500).send("Internal Server Error");
    }
};

router.get('/returns/:year/:id',  authService.ensureRoles('admin'), renderYearlyReturns);

module.exports = router;
