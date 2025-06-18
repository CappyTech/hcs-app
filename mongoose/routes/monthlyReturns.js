const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/monthlyReturnsController');

router.get('/monthly/returns/form', authService.ensureRole(), ctrl.renderMonthlyReturnsForm);
router.get('/monthly/returns/:month/:year/:uuid', authService.ensureRole(), ctrl.renderMonthlyReturns);

module.exports = router;
