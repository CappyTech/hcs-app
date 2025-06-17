const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');

router.get('/mongo/customers', customerController.listCustomers);
router.get('/mongo/customers/new', customerController.renderCreateForm);
router.post('/mongo/customers/new', customerController.createCustomer);
router.get('/mongo/customers/:id', customerController.showCustomer);

module.exports = router;
