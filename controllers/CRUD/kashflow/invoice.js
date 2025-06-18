const express = require('express');
const router = express.Router();
const logger = require('../../../services/loggerService');
const path = require('path');
const db = require('../../../services/kashflowDatabaseService');
const authService = require('../../../services/authService');

const readInvoice = async (req, res, next) => {
    try {
        const Invoice = await db.KF_Invoices.findByPk(req.params.uuid, {
            include: [
                {
                    model: db.KF_Customers,
                    as: 'customer',
                    attributes: ['uuid', 'Name'],
                }
            ]
        });

        if (!Invoice) {
            req.flash('error', 'Invoice not found.');
            return res.redirect('/dashboard/KFinvoice');
        }

        // Parse Lines if stored as a JSON string
        Invoice.Lines = typeof Invoice.Lines === 'string' ? JSON.parse(Invoice.Lines) : Invoice.Lines || [];

        res.render(path.join('kashflow', 'viewInvoice'), {
            title: 'Invoice Overview',
            Invoice,
            Customer: Invoice.customer, // Pass customer data to EJS
        });
    } catch (error) {
        logger.error('Error reading kashflow Invoice: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error);
    }
};


router.get('/invoice/read/:uuid',  authService.ensureRoles('admin'), readInvoice);

module.exports = router;