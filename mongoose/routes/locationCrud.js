const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/locationCRUDController');

router.post('/location/create', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.createLocation);
router.get('/location/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.readLocation);
router.post('/location/update/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.updateLocation);
router.post('/location/delete/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.deleteLocation);

module.exports = router;
