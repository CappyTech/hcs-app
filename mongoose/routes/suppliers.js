const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const suppliers = require('../controllers/suppliersController');

router.get('/suppliers',  auth.ensureRoles(['adminAccess']), suppliers.listSuppliers);
router.get('/supplier/read/:uuid',  auth.ensureRoles(['adminAccess']), suppliers.viewSupplier);

module.exports = router;
