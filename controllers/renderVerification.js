const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../services/sequelizeDatabaseService');
const kf = require('../services/kashflowDatabaseService');
const logger = require('../services/loggerService');
const authService = require('../services/authService');

const renderSubcontractorVerification = async (req, res, next) => {
    try {
        const suppliers = await kf.KF_Suppliers.findAll();
        const subcontractors = await db.Subcontractors.findAll();

        res.render(path.join('verification', 'subcontractor'), {
            title: 'Subcontractor Verification',
            suppliers,
            subcontractors,
        });
    } catch (error) {
        logger.error('Error rendering supplier verification: ' + error.message);
        req.flash('error', 'Failed to load suppliers.');
        next(error); // Pass the error to the error handler
    }
};

const renderInvoiceVerification = async (req, res, next) => {
    try {
        const receipts = await kf.KF_Receipts.findAll();
        const invoices = await db.Invoices.findAll();

        res.render(path.join('verification', 'invoice'), {
            title: 'Invoice Verification',
            receipts,
            invoices,
        });
    } catch (error) {
        logger.error('Error rendering receipt verification: ' + error.message);
        req.flash('error', 'Failed to load receipts.');
        next(error); // Pass the error to the error handler
    }
};

const renderClientVerification = async (req, res, next) => {
    try {
        const customers = await kf.KF_Customer.findAll();
        const clients = await db.Clients.findAll();

        res.render(path.join('verification', 'client'), {
            title: 'Client Verification',
            customers,
            clients,
        });
    } catch (error) {
        logger.error('Error rendering supplier verification: ' + error.message);
        req.flash('error', 'Failed to load suppliers.');
        next(error); // Pass the error to the error handler
    }
};

router.get('/subcontractor',  authService.ensureRoles('admin'), renderSubcontractorVerification);
router.get('/invoice',  authService.ensureRoles('admin'), renderInvoiceVerification);
router.get('/client',  authService.ensureRoles('admin'), renderClientVerification);

module.exports = router;