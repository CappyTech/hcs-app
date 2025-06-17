const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const settings = require('../controllers/settingsController');

router.get('/user/profile', auth.ensureAuthenticated, settings.getProfilePage);
router.get('/user/account', auth.ensureAuthenticated, settings.getAccountPage);
router.post('/user/account/settings', auth.ensureAuthenticated, settings.validateAccountSettings, settings.updateAccountSettings);
router.post('/user/account/logout-session', auth.ensureAuthenticated, settings.logoutSession);

module.exports = router;
