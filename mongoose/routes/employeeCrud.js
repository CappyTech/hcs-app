const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/employeeCRUDController');

router.post('/employee/create', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.createEmployee);
router.get('/employee/read/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.readEmployee);
router.post('/employee/update/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.updateEmployee);
router.post('/employee/delete/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.deleteEmployee);

module.exports = router;
