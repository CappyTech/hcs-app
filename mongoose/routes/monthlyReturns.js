const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/monthlyReturnsController');

router.get('/monthly/returns/form', ctrl.renderMonthlyReturnsForm);
router.get('/monthly/returns/:month/:year/:uuid', ctrl.renderMonthlyReturns);

module.exports = router;
