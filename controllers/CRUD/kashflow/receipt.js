const express = require('express');
const router = express.Router();
const logger = require('../../../services/loggerService');
const moment = require('moment');
const path = require('path');
const kf = require('../../../services/kashflowDatabaseService');
const authService = require('../../../services/authService');
const normalizePayments = require('../../../services/kashflowNormalizer').normalizePayments;
const getReceiptPayment = require('../../../kf/getReceiptPayment');
const authenticate = require('../../../kf/autoAuth');

const readReceipt = async (req, res, next) => {
    try {
        // Fetch Receipt with its associated supplier
        const Receipt = await kf.KF_Receipts.findByPk(req.params.uuid, {
            include: [{ model: kf.KF_Suppliers, as: 'supplier' }],
        });
        logger.debug('Receipt Data: ' + JSON.stringify(Receipt, null, 2));
        
        if (!Receipt) {
            req.flash('error', 'Receipt not found.');
            return res.redirect('/dashboard/KFreceipt');
        }

        const context = `read receipt  - working on: ${Receipt.supplier.Name} (${Receipt.InvoiceNumber})`;
        const client = await authenticate(context);
        const receiptPayments = await getReceiptPayment(client, Receipt.InvoiceNumber);
        logger.debug('Receipt Payments: ' + JSON.stringify(receiptPayments, null, 2));

        const flatPayments = normalizePayments(Receipt.Payments);
        await Receipt.update({ Payments: flatPayments });

        res.render(path.join('kashflow', 'viewReceipt'), {
            title: 'Receipt Overview',
            Receipt: Receipt,
            Supplier: Receipt.supplier
        });
    } catch (error) {
        logger.error('Error reading KashFlow Receipt: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler middleware in app.js for logging and debugging purposes (if needed)
    }
};

router.get('/receipt/read/:uuid',  authService.ensureRole(), readReceipt);

router.post('/receipt/:uuid/change',  authService.ensureRole(), async (req, res) => {
    try {
        const receipt = await kf.KF_Receipts.findOne({ where: { uuid: req.params.uuid } });

        if (!receipt) {
            return res.status(404).send('Receipt not found');
        }

        await receipt.update({ SubmissionDate: req.body.submissionDate });

        res.redirect(`/kashflow/receipt/read/${receipt.uuid}`);
    } catch (error) {
        logger.error('Error updating submission date: '+ error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler middleware in app.js for logging and debugging purposes (if needed)
    }
});

router.post('/receipt/change',  authService.ensureRole(), async (req, res) => {
    try {
        const { submissionDate, uuids, redirectPath  } = req.body;
        const targetUUIDs = uuids?.length ? Array.isArray(uuids) ? uuids : [uuids] : [req.params.uuid];
        const receipt = await kf.KF_Receipts.findAll({ where: { uuid: targetUUIDs } });

        if (!receipt) {
            return res.status(404).send('Receipt not found');
        }

        // Update all matching receipts
        await kf.KF_Receipts.update(
            { SubmissionDate: submissionDate },
            { where: { uuid: targetUUIDs } }
        );

        res.redirect(redirectPath || `/CIS`);
    } catch (error) {
        logger.error('Error updating submission date: '+ error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler middleware in app.js for logging and debugging purposes (if needed)
    }
});

router.post('/receipt/:uuid/submit',  authService.ensureRole(), async (req, res) => {
    try {
        const receipt = await kf.KF_Receipts.findOne({ where: { uuid: req.params.uuid } });

        if (!receipt) {
            return res.status(404).send('Receipt not found');
        }

        // Update SubmissionDate to today's date
        const today = moment().format('YYYY-MM-DD');
        await receipt.update({ SubmissionDate: today });

        res.redirect(`/kashflow/receipt/read/${receipt.uuid}`);
    } catch (error) {
        logger.error('Error updating submission date: '+ error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler middleware in app.js for logging and debugging purposes (if needed)
    }
});

router.post('/receipt/:uuid/cancel',  authService.ensureRole(), async (req, res) => {
    try {
        const receipt = await kf.KF_Receipts.findOne({ where: { uuid: req.params.uuid } });

        if (!receipt) {
            return res.status(404).send('Receipt not found');
        }

        await receipt.update({ SubmissionDate: null });

        res.redirect(`/kashflow/receipt/read/${receipt.uuid}`);
    } catch (error) {
        logger.error('Error updating submission date: '+ error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler middleware in app.js for logging and debugging purposes (if needed)
    }
});

module.exports = router;