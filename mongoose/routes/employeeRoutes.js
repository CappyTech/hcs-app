const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/employeeCRUDController');

router.get('/employees', authService.ensureRole(), ctrl.listEmployees);
router.get('/employee/create', authService.ensureRole(), ctrl.renderCreateEmployeeForm);
router.get('/employee/update/:id', authService.ensureRole(), ctrl.renderUpdateEmployeeForm);

router.post('/employee/create', authService.ensureRole(), ctrl.createEmployee);
router.get('/employee/read/:id', authService.ensureRole(), ctrl.readEmployee);
router.post('/employee/update/:id', authService.ensureRole(), ctrl.updateEmployee);
router.post('/employee/delete/:id', authService.ensureRole(), ctrl.deleteEmployee);

module.exports = router;
