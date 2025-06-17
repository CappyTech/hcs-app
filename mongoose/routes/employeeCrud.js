const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.createEmployee);
router.get('/employee/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.readEmployee);
router.post('/employee/update/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.updateEmployee);
router.post('/employee/delete/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.deleteEmployee);

module.exports = router;
