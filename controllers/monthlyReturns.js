const express = require('express');
const router = express.Router();
const logger = require('../services/loggerService');
const path = require('path');
const db = require('../services/sequelizeDatabaseService');
const authService = require('../services/authService');

const renderMonthlyReturnsForm = async (req, res, next) => {
    try {
        

        // Define the monthNames array starting with April as month 1
        const monthNames = [
            'April', 'May', 'June', 'July', 'August', 'September',
            'October', 'November', 'December', 'January', 'February', 'March'
        ];

        // Fetch all subcontractors from the database
        const subcontractors = await db.Subcontractors.findAll({
            include: {
                model: db.Invoices,
                as: 'invoices',
                attributes: ['year', 'month'],
                group: ['year', 'month'],
                order: [
                    ['year', 'DESC'],
                    ['month', 'DESC']
                ]
            }
        });

        // Modify the subcontractors data to group invoices by year and extract unique months
        const subcontractorsWithMonths = subcontractors.map(subcontractor => {
            const invoicesByYear = {};
            subcontractor.invoices.forEach(invoice => {
                const year = invoice.year;
                const month = invoice.month;
                if (!invoicesByYear[year]) {
                    invoicesByYear[year] = [];
                }

                if (!invoicesByYear[year].includes(month)) {
                    invoicesByYear[year].push(month);
                    invoicesByYear[year].sort((a, b) => monthNames.indexOf(monthNames[a - 1]) - monthNames.indexOf(monthNames[b - 1]));
                }
            });

            return {
                subcontractor: subcontractor,
                years: Object.keys(invoicesByYear).sort((a, b) => b - a),
                invoicesByYear: invoicesByYear,
            };
        });

        // Render the EJS view, passing in the modified subcontractors data
        res.render(path.join('monthlyreturns', 'monthlyReturnsForm'), {
            title: 'Monthly Returns Form',
            subcontractorsWithMonths: subcontractorsWithMonths,
            monthNames: monthNames
        });
    } catch (error) {
        logger.error("Error rendering the form:", error);
        req.flash('error', 'Error: Unable to render monthly returns');
        const referrer = req.get('referer') || '/';
        res.redirect(referrer);
    }
};

const renderMonthlyReturnsForOneSubcontactor = async (req, res, next) => {
    try {
        
        const { month, year, id } = req.params;

        if (!month || !year || !id) {
            logger.warn("Month, Year, and Subcontractor are required.");
            return res.status(400).send("Month, Year, and Subcontractor are required.");
        }

        const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];

        const subcontractor = await db.Subcontractors.findAll({
            where: {
                id: id,
                deletedAt: null
            },
            include: {
                model: db.Invoices,
                as: 'invoices',
                where: {
                    month: month,
                    year: year
                }
            }
        });

        logger.info("Rendering monthly returns:", {
            subcontractor: subcontractor,
            month: month,
            year: year
        });

        res.render(path.join('monthlyreturns', 'monthlyReturnsForOneSubcontractor'), {
            title: 'Monthly Returns Subcontractor',
            month: month,
            year: year,
            subcontractor: subcontractor[0],
            invoices: subcontractor[0].invoices,
            monthNames: monthNames
        });
    } catch (error) {
        logger.error("Error rendering monthly returns:", error);
        req.flash('error', 'Error: Unable to render monthly returns');
        res.redirect('/monthly/returns/form');
    }
};

const renderMonthlyReturnsForAll = async (req, res, next) => {
    try {
        
        const { month, year } = req.params;

        if (!month || !year) {
            logger.warn("Month and Year are required.");
            return res.status(400).send("Month and Year are required.");
        }

        const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];

        const subcontractors = await db.Subcontractors.findAll({
            where: {
                deletedAt: null
            },
            include: {
                model: db.Invoices,
                as: 'invoices',
                where: {
                    month: month
                },
                order: [['invoiceNumber', 'ASC']]
            },
            order: [['name', 'ASC']]
        });

        logger.info("Rendering monthly returns:", {
            subcontractors: subcontractors,
            month: month,
            year: year
        });

        res.render(path.join('monthlyreturns', 'monthlyReturnsForAll'), {
            title: 'Monthly Returns',
            month: month,
            year: year,
            subcontractors: subcontractors,
            monthNames: monthNames
        });
    } catch (error) {
        logger.error("Error rendering monthly returns:", error);
        req.flash('error', 'Error: Unable to render monthly returns');
        res.redirect('/monthly/returns/form');
    }
};

const renderMonthlyReturnsYear = async (req, res, next) => {
    try {
        
        const { year } = req.params;

        if (!year) {
            logger.warn("Year is required.");
            return res.status(400).send("Year is required.");
        }

        const monthNames = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];

        const subcontractors = await db.Subcontractors.findAll({
            where: {
                deletedAt: null
            },
            include: {
                model: db.Invoices,
                as: 'invoices',
                where: {
                    year: year
                },
                order: [['invoiceNumber', 'ASC']]
            },
            order: [['company', 'ASC']]
        });

        logger.info("Rendering monthly returns:", { year: year });

        res.render(path.join('monthlyreturns', 'renderMonthlyReturnsYear'), {
            title: 'Monthly Returns Report',
            year: year,
            subcontractors,
            invoices: subcontractors.invoices,
            monthNames: monthNames
        });
    } catch (error) {
        logger.error("Error rendering monthly returns:", error);
        req.flash('error', 'Error: Unable to render monthly returns');
        res.redirect('/monthly/returns/form');
    }
};

router.get('/returns/form',  authService.ensureRoles('admin'), renderMonthlyReturnsForm);
router.get('/returns/:month/:year/:id',  authService.ensureRoles('admin'), renderMonthlyReturnsForOneSubcontactor);
router.get('/returns/:year/:month',  authService.ensureRoles('admin'), renderMonthlyReturnsForAll);
router.get('/returns/:year',  authService.ensureRoles('admin'), renderMonthlyReturnsYear);

module.exports = router;
