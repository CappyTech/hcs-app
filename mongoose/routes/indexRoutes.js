const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const index = require('../controllers/indexController');

router.get('/', index.renderIndex);
router.get('/construction-industry-scheme',  index.renderConstructionIndustryScheme);
router.get('/management',  index.renderManagement);
router.get('/payroll',  index.renderPayroll);
router.get('/human-resources',  index.renderHumanResources);
router.get('/kashflow',  index.renderKashflow);
router.get('/create',  index.renderCreate);

module.exports = router;
