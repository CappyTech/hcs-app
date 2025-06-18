const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/yearlyReturnsController');

router.get('/yearly/returns/:year/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.renderYearlyReturns);

module.exports = router;
