const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const settings = require('../controllers/settingsController');

router.get('/user/profile', authService.ensureRole(), settings.getProfilePage);
router.get('/user/account', authService.ensureRole(), settings.getAccountPage);
router.post('/user/account/settings', authService.ensureRole(), settings.validateAccountSettings, settings.updateAccountSettings);
router.post('/user/account/logout-session', authService.ensureRole(), settings.logoutSession);

module.exports = router;
