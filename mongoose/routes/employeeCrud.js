const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create', authService.ensureRole(), ctrl.createEmployee);
router.get('/employee/read/:id', authService.ensureRole(), ctrl.readEmployee);
router.post('/employee/update/:id', authService.ensureRole(), ctrl.updateEmployee);
router.post('/employee/delete/:id', authService.ensureRole(), ctrl.deleteEmployee);

module.exports = router;
