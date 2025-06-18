const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const invoices = require('../controllers/invoicesController');

router.get('/invoices', auth.ensureRole(), invoices.listInvoices);
router.get('/invoice/read/:uuid', auth.ensureRole(), invoices.viewInvoice);

module.exports = router;
