const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const index = require('../controllers/indexController');

router.get('/', authService.ensureRole('none'), index.renderIndex);
router.get('/construction-industry-scheme', authService.ensureRole(), index.renderConstructionIndustryScheme);
router.get('/management', authService.ensureRole(), index.renderManagement);
router.get('/payroll', authService.ensureRole(), index.renderPayroll);
router.get('/human-resources', authService.ensureRole(), index.renderHumanResources);
router.get('/kashflow', authService.ensureRole(), index.renderKashflow);
router.get('/create', authService.ensureRole(), index.renderCreate);

module.exports = router;
