const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const invoices = require('../controllers/KFinvoicesController');

router.get('/invoices', authService.ensureRole(), invoices.listInvoices);
router.get('/invoice/read/:uuid', authService.ensureRole(), invoices.viewInvoice);

module.exports = router;
