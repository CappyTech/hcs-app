const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const suppliers = require('../controllers/suppliersController');

router.get('/suppliers', authService.ensureRole(), suppliers.listSuppliers);
router.get('/supplier/read/:uuid', authService.ensureRole(), suppliers.viewSupplier);

module.exports = router;
