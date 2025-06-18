const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/locationCRUDController');

router.post('/location/create', authService.ensureRole(), ctrl.createLocation);
router.get('/location/read/:uuid', authService.ensureRole(), ctrl.readLocation);
router.post('/location/update/:uuid', authService.ensureRole(), ctrl.updateLocation);
router.post('/location/delete/:uuid', authService.ensureRole(), ctrl.deleteLocation);

module.exports = router;
