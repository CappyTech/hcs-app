const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const invoices = require('../controllers/invoicesController');

router.get('/invoices',  auth.ensureRoles(['adminAccess']), invoices.listInvoices);
router.get('/invoice/read/:uuid',  auth.ensureRoles(['adminAccess']), invoices.viewInvoice);

module.exports = router;
