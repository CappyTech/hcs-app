const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create', auth.ensureRole(), ctrl.createEmployee);
router.get('/employee/read/:uuid', auth.ensureRole(), ctrl.readEmployee);
router.post('/employee/update/:uuid', auth.ensureRole(), ctrl.updateEmployee);
router.post('/employee/delete/:uuid', auth.ensureRole(), ctrl.deleteEmployee);

module.exports = router;
