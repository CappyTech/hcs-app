const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/yearlyReturnsController');

router.get('/yearly/returns/:year/:uuid', authService.ensureRole(), ctrl.renderYearlyReturns);

module.exports = router;
