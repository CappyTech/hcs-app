const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/cisController');

router.get('/CIS/Dashboard/:year/:month', authService.ensureRole(), ctrl.renderCISDashboardMongo);
router.get('/CIS/Dashboard/', authService.ensureRole(), ctrl.redirectCIS);

module.exports = router;
