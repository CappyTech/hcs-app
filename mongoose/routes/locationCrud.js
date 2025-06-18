const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/locationCRUDController');

router.post('/location/create', auth.ensureRole(), ctrl.createLocation);
router.get('/location/read/:uuid', auth.ensureRole(), ctrl.readLocation);
router.post('/location/update/:uuid', auth.ensureRole(), ctrl.updateLocation);
router.post('/location/delete/:uuid', auth.ensureRole(), ctrl.deleteLocation);

module.exports = router;
