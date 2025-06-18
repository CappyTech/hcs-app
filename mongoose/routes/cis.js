const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const cis = require('../controllers/cisController');

router.get('/mdb/CIS/:year/:month',  auth.ensureRoles(['adminAccess']), cis.renderCISDashboardMongo);
router.get('/mdb/CIS',  auth.ensureRoles(['adminAccess']), cis.redirectCIS);

module.exports = router;
