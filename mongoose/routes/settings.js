const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const settings = require('../controllers/settingsController');

router.get('/user/profile', auth.ensureRole(), settings.getProfilePage);
router.get('/user/account', auth.ensureRole(), settings.getAccountPage);
router.post('/user/account/settings', auth.ensureRole(), settings.validateAccountSettings, settings.updateAccountSettings);
router.post('/user/account/logout-session', auth.ensureRole(), settings.logoutSession);

module.exports = router;
