import express from 'express';
import rateLimit from 'express-rate-limit';
import { getClientIp } from '../../services/ipService.js';
import authService from '../../services/authService.js';
import ctrl from '../controllers/paymentController.js';

const router = express.Router();

/**
 * Bulk supplier payment routes.
 *
 * Every path here is also listed in rolePermissionsConfig.routeAccess, which
 * the global ensureRouteAccess middleware enforces; the per-route guards below
 * are the second layer.
 *
 * Finance department, admin + accountant — the same audience as /bank. The
 * confirm step writes real money movements to KashFlow, so it carries a strict
 * rate limiter on top of CSRF.
 */

// Finance department: admin and accountant (mirrors bankGuard).
// Finance manage (Director) as well, under separationOfDutiesService.
const financeGuard = [
  authService.ensureAuthenticated,
  authService.ensureGroup('finance', 'manage', 'admin', 'accountant'),
  authService.ensureDepartment('finance'),
];

// The confirm step issues a financial write to KashFlow. Keep it slow.
const confirmLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: 'Too many payment attempts — please wait before trying again.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

router.get('/payments/bulk', ...financeGuard, ctrl.getBulkPay);
router.post('/payments/bulk/preview', ...financeGuard, ctrl.postPreview);
router.post('/payments/bulk/confirm', ...financeGuard, confirmLimiter, ctrl.postConfirm);

export default router;
