const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/locationCRUDController');

router.post('/location/create', ctrl.createLocation);
router.get('/location/read/:uuid', ctrl.readLocation);
router.post('/location/update/:uuid', ctrl.updateLocation);
router.post('/location/delete/:uuid', ctrl.deleteLocation);

module.exports = router;
