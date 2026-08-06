import express from 'express';
import authService from '../../services/authService.js';
import ctrl from '../controllers/accountantController.js';

const router = express.Router();

/**
 * Read-only bank reconciliation portal, for an external accountant.
 *
 * The security property this file exists to hold: **there is no POST here.**
 * Not a disabled one, not a guarded one — none. Read-only is therefore a fact
 * about the routing table rather than a claim about the templates, and it
 * cannot be undone by someone forging a form or by a control that was missed
 * when a view was edited.
 *
 * Keep it that way. If the external accountant ever needs to record something,
 * it belongs behind the existing /bank guards with a role that is allowed to
 * write — not behind a new POST added to this router. tests/accountantRoutes
 * .test.js fails the build if one appears.
 *
 * The 'auditor' role reaches only this prefix: routeAccess maps '/accountant'
 * to it and '/bank' to admin/accountant, and matchRoutePattern takes the
 * longest matching prefix, so /bank is refused for auditors by the global
 * ensureRouteAccess middleware before any route guard runs.
 */

// Read guard. 'accountant' and 'admin' are included so the internal team can
// see exactly what the external accountant sees — a portal nobody in-house can
// open is a portal nobody in-house can support.
const readGuard = [
  authService.ensureAuthenticated,
  authService.ensureRoles('admin', 'accountant', 'auditor'),
  authService.ensureDepartment('accountant-portal'),
];

router.get('/accountant', ...readGuard, ctrl.getOverview);
router.get('/accountant/queries', ...readGuard, ctrl.getQueries);
router.get('/accountant/signoff', ...readGuard, ctrl.getSignOffs);

router.get('/accountant/statements', ...readGuard, ctrl.getStatements);
router.get('/accountant/statements/:uuid', ...readGuard, ctrl.getStatement);

router.get('/accountant/accounts/:accountId', ...readGuard, ctrl.getAccount);

// The account is part of the line's identity: an internal transfer is two
// ledger lines sharing one KashFlow Id.
router.get('/accountant/lines/:bankAccountId/:bankTransactionId', ...readGuard, ctrl.getLine);

export default router;
