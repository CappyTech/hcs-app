const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const invoices = require('../controllers/invoicesController');

router.get('/invoices', auth.ensureAuthenticated, auth.ensureRole('admin'), invoices.listInvoices);
router.get('/invoice/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), invoices.viewInvoice);

module.exports = router;
