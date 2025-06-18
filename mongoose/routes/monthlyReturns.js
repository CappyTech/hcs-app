const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/monthlyReturnsController');

router.get('/monthly/returns/form',  auth.ensureRoles(['adminAccess']), ctrl.renderMonthlyReturnsForm);
router.get('/monthly/returns/:month/:year/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.renderMonthlyReturns);

module.exports = router;
