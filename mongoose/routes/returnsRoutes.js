const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/returnsController');

// Monthly returns selection form
router.get('/CIS/returns/form', authService.ensureRole(), ctrl.renderMonthlyReturnsForm);
// All subcontractors: Full yearly CIS return
router.get('/CIS/returns/yearly/:year', authService.ensureRole(), ctrl.renderYearlyReturnsForAll);
// Single subcontractor: Single month
router.get('/CIS/returns/:month/:year/:uuid', authService.ensureRole(), ctrl.renderMonthlyReturns);
// Single subcontractor: Full yearly CIS return
router.get('/CIS/returns/:year/:uuid', authService.ensureRole(), ctrl.renderYearlyReturns);
// All subcontractors: One specific month
router.get('/CIS/returns/:month/:year', authService.ensureRole(), ctrl.renderMonthlyReturnsForAll);

module.exports = router;
