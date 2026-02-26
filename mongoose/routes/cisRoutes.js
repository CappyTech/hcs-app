const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/cisController');

router.get('/CIS/Dashboard/:year/:month', authService.ensureRoles('admin', 'accountant', 'hmrc'), ctrl.renderCISDashboardMongo);
router.get('/CIS/Dashboard/', authService.ensureRoles('admin', 'accountant', 'hmrc'), ctrl.redirectCIS);

module.exports = router;
