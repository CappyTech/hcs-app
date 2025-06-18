const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const settings = require('../controllers/settingsController');

router.get('/user/profile',  settings.getProfilePage);
router.get('/user/account',  settings.getAccountPage);
router.post('/user/account/settings',  settings.validateAccountSettings, settings.updateAccountSettings);
router.post('/user/account/logout-session',  settings.logoutSession);

module.exports = router;
