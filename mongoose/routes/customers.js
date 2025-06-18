const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const customers = require('../controllers/customersController');

router.get('/customers', customers.listCustomers);
router.get('/customer/read/:uuid', customers.viewCustomer);

module.exports = router;
