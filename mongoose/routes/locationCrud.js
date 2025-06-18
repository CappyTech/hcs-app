const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/locationCRUDController');

router.post('/location/create',  auth.ensureRoles(['adminAccess']), ctrl.createLocation);
router.get('/location/read/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.readLocation);
router.post('/location/update/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.updateLocation);
router.post('/location/delete/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.deleteLocation);

module.exports = router;
