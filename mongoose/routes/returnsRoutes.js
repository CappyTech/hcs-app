const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/returnsController');

// Monthly returns selection form
router.get('/CIS/returns/form', authService.ensureRole(), ctrl.renderMonthlyReturnsForm);

// All subcontractors: Full yearly CIS return
router.get('/CIS/returns/all/:year', authService.ensureRole(), ctrl.renderYearlyReturnsForAll);

// All subcontractors: One specific month
router.get('/CIS/returns/all/:year/:month', authService.ensureRole(), ctrl.renderMonthlyReturnsForAll);

// Single subcontractor: Full yearly CIS return
router.get('/CIS/returns/:uuid/yearly/:year', authService.ensureRole(), ctrl.renderYearlyReturns);

// Single subcontractor: Single month
router.get('/CIS/returns/:uuid/:year/:month', authService.ensureRole(), ctrl.renderMonthlyReturns);

module.exports = router;
