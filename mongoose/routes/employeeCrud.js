const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create', authService.ensureRole(), ctrl.createEmployee);
router.get('/employee/read/:uuid', authService.ensureRole(), ctrl.readEmployee);
router.post('/employee/update/:uuid', authService.ensureRole(), ctrl.updateEmployee);
router.post('/employee/delete/:uuid', authService.ensureRole(), ctrl.deleteEmployee);

module.exports = router;
