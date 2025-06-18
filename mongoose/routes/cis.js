const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const cis = require('../controllers/cisController');

router.get('/mdb/CIS/:year/:month', authService.ensureRole(), cis.renderCISDashboardMongo);
router.get('/mdb/CIS', authService.ensureRole(), cis.redirectCIS);

module.exports = router;
