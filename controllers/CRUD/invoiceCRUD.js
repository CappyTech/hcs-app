const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService'); 
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');
const validationService = require('../../services/validationService');
const cisService = require('../../services/cisService');
const taxService = require('../../services/taxService');

const createInvoice = async (req, res, next) => {
    try {
        const validatedData = validationService.validateInvoiceData(req.body);

        const subcontractor = await db.Subcontractors.findByPk(req.params.selected, {
            include: [{ model: db.Invoices, as: 'invoices' }],
        });
        if (!subcontractor) {
            logger.error(`Subcontractor with ID ${req.params.selected} not found.`);
            req.flash('error', 'Subcontractor not found.');
            return res.redirect('/invoices');
        }

        const amounts = cisService.calculateInvoiceAmounts(validatedData.labourCost, validatedData.materialCost, subcontractor.deduction, subcontractor.cisNumber, subcontractor.vatNumber);

        // If remittanceDate or submissionDate are not provided, set them to null
        validatedData.remittanceDate = validatedData.remittanceDate || null;
        validatedData.submissionDate = validatedData.submissionDate || null;

        // Calculate Tax Year and Tax Month
        const { taxYear, taxMonth } = taxService.calculateTaxYearAndMonth(validatedData.remittanceDate);

        // Create invoice
        const newInvoice = await db.Invoices.create({
            invoiceNumber: validatedData.invoiceNumber,
            kashflowNumber: validatedData.kashflowNumber,
            invoiceDate: validatedData.invoiceDate,
            remittanceDate: validatedData.remittanceDate || null,
            grossAmount: amounts.grossAmount,
            labourCost: validatedData.labourCost,
            materialCost: validatedData.materialCost,
            cisAmount: amounts.cisAmount,
            netAmount: amounts.netAmount,
            submissionDate: validatedData.submissionDate || null,
            reverseCharge: amounts.reverseCharge,
            month: taxMonth,
            year: taxYear,
            subcontractorId: subcontractor.id, // Use valid ID
            cisRate: amounts.cisRate,
        });

        res.redirect(`/invoice/read/${newInvoice.id}`);

    } catch (error) {
        if (error.name === 'SequelizeValidationError') {
            const errorMessages = error.errors.map((error) => error.message);
            logger.error(`Validation errors: ${errorMessages.join(', ')}`);
            return res.render('createInvoice', {
                title: 'Create Invoice',
            });
        }
        logger.error('Error creating invoice: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const updateInvoice = async (req, res, next) => {
    try {
        const invoice = await db.Invoices.findByPk(req.params.invoice);
        if (!invoice) {
            throw new Error('Invoice not found');
        }
        if (!invoice.subcontractorId) {
            logger.error(`No subcontractorId associated with invoice number: ${req.params.invoice}`);
        }
        const subcontractor = await db.Subcontractors.findByPk(invoice.subcontractorId);
        if (!subcontractor) {
            logger.error(`Subcontractor with ID: ${invoice.subcontractorId} not found for invoice ${req.params.invoice}`);
        }
        const amounts = cisService.calculateInvoiceAmounts(req.body.labourCost, req.body.materialCost, subcontractor.deduction, subcontractor.cisNumber, subcontractor.vatNumber, subcontractor.isGross, subcontractor.isReverseCharge);

        await db.Invoices.update({ ...req.body, ...amounts }, { where: { id: req.params.invoice } });

        req.flash('success', 'Invoice updated successfully');
        return res.redirect(`/invoice/read/${req.params.invoice}`);
    } catch (error) {
        logger.error(`Error updating invoice with ID: ${req.params.invoice}. Details:` + error.message);
        req.flash('error', `Error updating invoice with ID: ${req.params.invoice}. Details:` + error.message);
        return res.redirect(`/invoice/read/${req.params.invoice}`);
    }
};

const readInvoice = async (req, res, next) => {
    try {
        const invoice = await db.Invoices.findByPk(req.params.invoice, {
            include: [
                { model: db.Subcontractors }
            ]
        });

        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        res.render(path.join('invoices', 'viewInvoice'), {
            title: 'Invoice',
            invoice,
        });
    } catch (error) {
        logger.error('Error viewing invoice: ' + error.message);
        req.flash('error', 'Error viewing invoice: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const readInvoices = async (req, res, next) => {
    try {
        const subcontractor = await db.Subcontractors.findByPk(req.params.subcontractor);
        const invoices = await db.Invoices.findAll({
            include: [
                {
                    model: db.Subcontractors,
                    where: { id: req.params.subcontractor }
                }
            ],
            order: [['invoiceNumber', 'DESC']]
        });

        if (!invoices) {
            return res.status(404).json({ error: 'Invoices not found' });
        }

        res.render(path.join('invoices', 'viewInvoices'), {
            title: 'Invoices',
            subcontractor,
            invoices,
        });
    } catch (error) {
        logger.error('Error viewing invoices:'+ error.message);
        req.flash('error', 'Error viewing invoices:' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const deleteInvoice = async (req, res, next) => {
    try {
        // Check if the user is an admin
        
        // TODO: Add subcontractorId to the invoice model and refer back to the /invoices/read/:id route
        const invoice = await db.Invoices.findByPk(req.params.invoice);

        if (!invoice) {
            req.flash('error', 'Invoice not found');
            return res.redirect(req.get('referer') || '/dashboard/stats');
        }

        await invoice.destroy();

        req.flash('success', 'Invoice deleted successfully');
        res.redirect('/dashboard/invoice');
    } catch (error) {
        logger.error('Error deleting invoice: ' + error.message);
        req.flash('error', 'Error deleting invoice: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

router.get('/fetch/invoice/:id', async (req, res, next) => {
    try {
        

        const invoice = await db.Invoices.findAll({
            where: { id: req.params.id },
            order: [['createdAt', 'ASC']],
        });

        res.json({ invoice });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});

router.get('fetch/unpaidinvoices', async (req, res, next) => {
    try {
        

        const unpaidInvoices = await db.Invoices.findAll({
            where: { remittanceDate: null },
            attributes: ['id', 'kashflowNumber'],
            order: [['kashflowNumber', 'ASC']]
        });

        res.json({ unpaidInvoices });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch unpaid invoices' });
    }
});

router.get('fetch/unsubmittedinvoices', async (req, res, next) => {
    try {
        

        const unsubmittedInvoices = await db.Invoices.findAll({
            where: { submissionDate: null },
            attributes: ['id', 'kashflowNumber'],
            order: [['kashflowNumber', 'ASC']]
        });

        res.json({ unsubmittedInvoices });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch unsubmitted invoices' });
    }
});

router.post('/create/:selected',  authService.ensureRoles('admin'), createInvoice);
router.get('/read/:invoice',  authService.ensureRoles('admin'), readInvoice);
router.get('/read/:subcontractor',  authService.ensureRoles('admin'), readInvoices);
router.post('/update/:invoice',  authService.ensureRoles('admin'), updateInvoice);
router.post('/delete/:invoice',  authService.ensureRoles('admin'), deleteInvoice);

module.exports = router;
