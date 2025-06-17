const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const invoices = require('../controllers/invoicesController');

router.get('/invoices', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), invoices.listInvoices);
router.get('/invoice/read/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), invoices.viewInvoice);

module.exports = router;
