import express from 'express';
import rateLimit from 'express-rate-limit';
import { getClientIp } from '../../services/ipService.js';
import ctrl from '../controllers/microsoftSsoController.js';

const router = express.Router();

// Public (no session) endpoints — protected by the OAuth `state` parameter and a
// per-IP rate limit. Both are GET: the start redirects to Entra, the callback is
// where Entra returns the user. They are listed in authService PUBLIC_PATHS so
// they work while logged out.
const ssoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  message: 'Too many Microsoft sign-in attempts — please wait a few minutes.',
});

router.get('/auth/microsoft', ssoLimiter, ctrl.start);
router.get('/auth/microsoft/callback', ssoLimiter, ctrl.callback);

export default router;
