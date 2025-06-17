const express = require('express');
const router = express.Router();
const twoFA = require('../controllers/twoFAController');

router.get('/user/2fa', twoFA.render2FAPage);
router.post('/user/2fa', twoFA.verify2FA);

module.exports = router;
