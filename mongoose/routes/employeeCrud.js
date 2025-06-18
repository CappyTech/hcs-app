const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create',  auth.ensureRoles(['adminAccess']), ctrl.createEmployee);
router.get('/employee/read/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.readEmployee);
router.post('/employee/update/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.updateEmployee);
router.post('/employee/delete/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.deleteEmployee);

module.exports = router;
