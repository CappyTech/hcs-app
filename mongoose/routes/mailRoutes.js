import express from 'express';
import authService from '../../services/authService.js';
import ctrl from '../controllers/mailFilterController.js';

const router = express.Router();

/**
 * Inbound mail filtering log.
 *
 * Admin only. These records are third-party personal data — every line names a
 * sender and a recipient, including people who appear nowhere else in this
 * system and never chose to deal with us. That is a narrower audience than the
 * finance department pattern used by /bank, and deliberately so; widening it is
 * one entry in rolePermissionsConfig.routeAccess plus the guard below, and
 * should be a decision rather than a drift.
 *
 * '/mail' is also listed in rolePermissionsConfig.routeAccess, which the global
 * ensureRouteAccess middleware enforces; the guard here is the second layer.
 * matchRoutePattern does literal longest-prefix matching with no :param
 * support, so the one '/mail' entry covers the whole module.
 *
 * GET only, and that is the enforcement mechanism rather than a convention:
 * this module cannot alter a filtering decision because it has no route that
 * writes one. Nothing here needs CSRF because nothing here mutates; a POST
 * appearing in this file means that reasoning has to be revisited, and
 * tests/mailRoutesGuards.test.js fails if one does.
 */
const mailGuard = [
  authService.ensureAuthenticated,
  authService.ensureRole('admin'),
];

router.get('/mail', ...mailGuard, ctrl.getIndex);
router.get('/mail/message/:id', ...mailGuard, ctrl.getMessage);

export default router;
