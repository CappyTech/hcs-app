const express = require('express');
const router = express.Router();
const twoFA = require('../controllers/twoFAController');
const authService = require('../../services/authService');

router.get('/user/2fa', authService.ensureRole(), twoFA.render2FAPage);
router.post('/user/2fa', authService.ensureRole(), twoFA.verify2FA);

module.exports = router;
