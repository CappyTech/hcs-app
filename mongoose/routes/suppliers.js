const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const suppliers = require('../controllers/suppliersController');

router.get('/suppliers', suppliers.listSuppliers);
router.get('/supplier/read/:uuid', suppliers.viewSupplier);

module.exports = router;
