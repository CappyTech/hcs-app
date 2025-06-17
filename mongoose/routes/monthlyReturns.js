const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/monthlyReturnsController');

router.get('/monthly/returns/form', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.renderMonthlyReturnsForm);
router.get('/monthly/returns/:month/:year/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.renderMonthlyReturns);

module.exports = router;
