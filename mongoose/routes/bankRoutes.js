import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { getClientIp } from '../../services/ipService.js';
import authService from '../../services/authService.js';
import csrfService from '../../services/csrfService.js';
import fileStorage from '../../services/fileStorage.js';
import ctrl from '../controllers/bankController.js';

const router = express.Router();

fileStorage.ensureStorageDirs();

/**
 * Statement uploads land under the managed storage root, never public/ — see
 * the 6.15.x change that moved uploaded documents out of the web root.
 */
const statementUpload = multer({
  dest: fileStorage.TEMP_DIR,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = /\.(csv|txt|ofx|qfx)$/;
    // Banks serve these under a wide range of content types, and some browsers
    // send application/octet-stream for .ofx, so the extension is the check.
    cb(allowed.test(ext) ? null : new Error('Upload a CSV or OFX statement.'), allowed.test(ext));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

// The account is part of the path because it is part of the line's identity:
// an internal transfer is two ledger lines sharing one KashFlow Id.
router.get('/bank/lines/:bankAccountId/:bankTransactionId', ...bankGuard, ctrl.getLine);

router.post('/bank/matches/:uuid/confirm', ...bankGuard, ctrl.postConfirm);
router.post('/bank/matches/:uuid/reject', ...bankGuard, ctrl.postReject);
router.post('/bank/matches/:uuid/unconfirm', ...adminGuard, ctrl.postUnconfirm);

router.post('/bank/generate', ...bankGuard, generateLimiter, ctrl.postGenerate);

router.get('/bank/rules', ...bankGuard, ctrl.getRules);
router.post('/bank/rules', ...bankGuard, ctrl.postRuleCreate);
router.post('/bank/rules/seed', ...bankGuard, ctrl.postRuleSeed);
router.post('/bank/rules/:uuid/test', ...bankGuard, ctrl.postRuleTest);
router.post('/bank/rules/:uuid/update', ...bankGuard, ctrl.postRuleUpdate);
router.post('/bank/rules/:uuid/delete', ...bankGuard, ctrl.postRuleDelete);

router.get('/bank/statements', ...bankGuard, ctrl.getStatements);
router.get('/bank/statements/:uuid', ...bankGuard, ctrl.getStatement);
// csrfService.validate runs AFTER multer: the global CSRF middleware sees no
// body on a multipart request, because it has not been parsed at that point.
router.post('/bank/statements/grab', ...bankGuard, generateLimiter, ctrl.postStatementGrab);
router.post(
  '/bank/statements/upload',
  ...bankGuard,
  statementUpload.single('statement'),
  csrfService.validate,
  ctrl.postStatementUpload,
);

router.get('/bank/signoff', ...bankGuard, ctrl.getSignOffs);
router.post('/bank/signoff', ...bankGuard, ctrl.postSignOff);
router.post('/bank/signoff/:uuid/reopen', ...adminGuard, ctrl.postReopen);

export default router;
