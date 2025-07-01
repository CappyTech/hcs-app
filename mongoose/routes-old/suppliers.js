const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const suppliers = require('../controllers/KFsuppliersController');

router.get('/suppliers', authService.ensureRole(), suppliers.listSuppliers);
router.get('/supplier/read/:uuid', authService.ensureRole(), suppliers.viewSupplier);
router.get('/supplier/change/:uuid', authService.ensureRole(), suppliers.renderChangeSupplierForm);
router.post('/supplier/change/:uuid', authService.ensureRole(), suppliers.changeSupplier);

module.exports = router;
