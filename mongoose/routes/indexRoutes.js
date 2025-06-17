const express = require('express');
const router = express.Router();
const authService = require('../../services/mongoose/authServiceMongoose');
const index = require('../controllers/indexController');

router.get('/', index.renderIndex);
router.get('/construction-industry-scheme', authService.ensureAuthenticated, index.renderConstructionIndustryScheme);
router.get('/management', authService.ensureAuthenticated, index.renderManagement);
router.get('/payroll', authService.ensureAuthenticated, index.renderPayroll);
router.get('/human-resources', authService.ensureAuthenticated, index.renderHumanResources);
router.get('/kashflow', authService.ensureAuthenticated, index.renderKashflow);
router.get('/create', authService.ensureAuthenticated, index.renderCreate);

module.exports = router;
