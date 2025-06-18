const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const customers = require('../controllers/customersController');

router.get('/customers',  auth.ensureRoles(['adminAccess']), customers.listCustomers);
router.get('/customer/read/:uuid',  auth.ensureRoles(['adminAccess']), customers.viewCustomer);

module.exports = router;
