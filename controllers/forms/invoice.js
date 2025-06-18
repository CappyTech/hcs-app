const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const renderInvoiceCreateForm = async (req, res, next) => {
    try {
        
        
        const subcontractors = await db.Subcontractors.findAll({
            order: [['company', 'ASC']]
        });
        res.render(path.join('invoices', 'createInvoice'), {
            title: 'Create Invoice',
            
            subcontractors,

        });
    } catch (error) {
        logger.error('Error rendering invoice create form:' + error.message);
        req.flash('error', 'Error rendering invoice create form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const renderInvoiceUpdateForm = async (req, res, next) => {
    try {
        

        const invoice = await db.Invoices.findByPk(req.params.invoice);

        if (!invoice) {
            return res.status(404).send('Invoice not found');
        }

        res.render(path.join('invoices', 'updateInvoice'), {
            title: 'Update Invoice',
            invoice,
            

        });
    } catch (error) {
        logger.error('Error rendering invoice update form:   ' + error.message);
        req.flash('error', 'Error rendering invoice update form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

router.get('/create',  authService.ensureRole(), renderInvoiceCreateForm);
router.get('/update/:invoice',  authService.ensureRole(), renderInvoiceUpdateForm);

module.exports = router;