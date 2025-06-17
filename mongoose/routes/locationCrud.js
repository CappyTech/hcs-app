const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/locationCRUDController');

router.post('/location/create', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.createLocation);
router.get('/location/read/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.readLocation);
router.post('/location/update/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.updateLocation);
router.post('/location/delete/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.deleteLocation);

module.exports = router;
