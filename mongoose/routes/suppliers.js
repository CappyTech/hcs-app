const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const suppliers = require('../controllers/suppliersController');

router.get('/suppliers', auth.ensureAuthenticated, auth.ensureRole('admin'), suppliers.listSuppliers);
router.get('/supplier/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), suppliers.viewSupplier);

module.exports = router;
