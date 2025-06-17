const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const customers = require('../controllers/customersController');

router.get('/customers', auth.ensureAuthenticated, auth.ensureRole('admin'), customers.listCustomers);
router.get('/customer/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), customers.viewCustomer);

module.exports = router;
