const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const cis = require('../controllers/cisController');

router.get('/mdb/CIS/:year/:month', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), cis.renderCISDashboardMongo);
router.get('/mdb/CIS', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), cis.redirectCIS);

module.exports = router;
