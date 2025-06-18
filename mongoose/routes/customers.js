const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const customers = require('../controllers/customersController');

router.get('/customers', authService.ensureRole(), customers.listCustomers);
router.get('/customer/read/:uuid', authService.ensureRole(), customers.viewCustomer);

module.exports = router;
