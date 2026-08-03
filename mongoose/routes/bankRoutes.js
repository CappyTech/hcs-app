import express from 'express';
import rateLimit from 'express-rate-limit';
import { getClientIp } from '../../services/ipService.js';
import authService from '../../services/authService.js';
import ctrl from '../controllers/bankController.js';

const router = express.Router();

/**
 * Bank reconciliation routes.
 *
 * Every path here is also listed in rolePermissionsConfig.routeAccess, which
 * is what the global ensureRouteAccess middleware enforces; the per-route
 * guards below are the second layer.
 */

// Generating suggestions walks thousands of lines and writes match records.
const generateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: 'Too many suggestion runs — please wait before triggering another.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

// Finance department: admin and accountant.
const bankGuard = [
  authService.ensureAuthenticated,
  authService.ensureRoles('admin', 'accountant'),
  authService.ensureDepartment('finance'),
];

// Reversing a confirmation or reopening a signed period is admin-only: both
// undo something a reviewer has already put their name to.
const adminGuard = [
  authService.ensureAuthenticated,
  authService.ensureRole('admin'),
  authService.ensureDepartment('finance'),
];

router.get('/bank', ...bankGuard, ctrl.getOverview);
router.get('/bank/exceptions', ...bankGuard, ctrl.getExceptions);

router.get('/bank/accounts/:accountId', ...bankGuard, ctrl.getAccount);
router.post('/bank/accounts/:accountId/bulk-confirm', ...bankGuard, ctrl.postBulkConfirm);

router.get('/bank/lines/:bankTransactionId', ...bankGuard, ctrl.getLine);

router.post('/bank/matches/:uuid/confirm', ...bankGuard, ctrl.postConfirm);
router.post('/bank/matches/:uuid/reject', ...bankGuard, ctrl.postReject);
router.post('/bank/matches/:uuid/unconfirm', ...adminGuard, ctrl.postUnconfirm);

router.post('/bank/generate', ...bankGuard, generateLimiter, ctrl.postGenerate);

router.get('/bank/signoff', ...bankGuard, ctrl.getSignOffs);
router.post('/bank/signoff', ...bankGuard, ctrl.postSignOff);
router.post('/bank/signoff/:uuid/reopen', ...adminGuard, ctrl.postReopen);

export default router;
