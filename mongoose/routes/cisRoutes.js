const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/cisController');

router.get('/CIS/:year/:month', authService.ensureRole(), ctrl.renderCISDashboardMongo);
router.get('/CIS', authService.ensureRole(), ctrl.redirectCIS);

module.exports = router;
