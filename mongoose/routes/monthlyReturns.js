const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/monthlyReturnsController');

router.get('/monthly/returns/form', auth.ensureRole(), ctrl.renderMonthlyReturnsForm);
router.get('/monthly/returns/:month/:year/:uuid', auth.ensureRole(), ctrl.renderMonthlyReturns);

module.exports = router;
