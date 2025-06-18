const express = require('express');
const router = express.Router();
const twoFA = require('../controllers/twoFAController');
const auth = require('../../services/authService');

router.get('/user/2fa', auth.ensureRole('none'), twoFA.render2FAPage);
router.post('/user/2fa', auth.ensureRole('none'), twoFA.verify2FA);

module.exports = router;
