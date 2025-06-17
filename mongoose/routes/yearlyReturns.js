const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/yearlyReturnsController');

router.get('/yearly/returns/:year/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), ctrl.renderYearlyReturns);

module.exports = router;
