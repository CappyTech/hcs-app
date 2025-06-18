const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const suppliers = require('../controllers/suppliersController');

router.get('/suppliers', auth.ensureRole(), suppliers.listSuppliers);
router.get('/supplier/read/:uuid', auth.ensureRole(), suppliers.viewSupplier);

module.exports = router;
