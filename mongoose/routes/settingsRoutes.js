const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const settings = require('../controllers/settingsController');

// All authenticated users can access their own profile/account
router.get('/user/profile', authService.ensureAnyRole(), settings.getProfilePage);
router.get('/user/account', authService.ensureAnyRole(), settings.getAccountPage);
router.post('/user/account/settings', authService.ensureAnyRole(), settings.validateAccountSettings, settings.updateAccountSettings);
router.post('/user/account/logout-session', authService.ensureAnyRole(), settings.logoutSession);

module.exports = router;
