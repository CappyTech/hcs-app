const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const cis = require('../controllers/cisController');

router.get('/mdb/CIS/:year/:month', cis.renderCISDashboardMongo);
router.get('/mdb/CIS', cis.redirectCIS);

module.exports = router;
