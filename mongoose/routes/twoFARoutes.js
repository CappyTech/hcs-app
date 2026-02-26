const express = require('express');
const router = express.Router();
const twoFA = require('../controllers/twoFAController');
const authService = require('../../services/authService');

// All authenticated users can manage their own 2FA
router.get('/user/2fa', authService.ensureAnyRole(), twoFA.render2FAPage);
router.post('/user/2fa', authService.ensureAnyRole(), twoFA.verify2FA);

module.exports = router;
