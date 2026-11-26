import express from 'express';
import authService from '../../services/authService.js';
import passkey from '../controllers/passkeyController.js';

const router = express.Router();

// Sign-in steps: no session guard. The sign-in endpoints are listed in
// authService PUBLIC_PATHS; the 2FA ones check userPending2FA themselves.
router.post('/user/passkey/login/options', passkey.loginOptions);
router.post('/user/passkey/login/verify', passkey.loginVerify);
router.post('/user/2fa/passkey/options', passkey.twoFAOptions);
router.post('/user/2fa/passkey/verify', passkey.twoFAVerify);

// Account Settings
router.post('/user/account/passkeys/options', authService.ensureAnyRole(), passkey.registerOptions);
router.post('/user/account/passkeys/register', authService.ensureAnyRole(), passkey.registerVerify);
router.post('/user/account/passkeys/remove', authService.ensureAnyRole(), passkey.removePasskey);

export default router;
