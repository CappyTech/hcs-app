const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create', ctrl.createEmployee);
router.get('/employee/read/:uuid', ctrl.readEmployee);
router.post('/employee/update/:uuid', ctrl.updateEmployee);
router.post('/employee/delete/:uuid', ctrl.deleteEmployee);

module.exports = router;
