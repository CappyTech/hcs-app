const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const customers = require('../controllers/customersController');

router.get('/customers', auth.ensureRole(), customers.listCustomers);
router.get('/customer/read/:uuid', auth.ensureRole(), customers.viewCustomer);

module.exports = router;
