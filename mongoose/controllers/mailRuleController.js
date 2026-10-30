/**
 * mailRuleController.js — GET /paperless/mail-rules: where to email each kind
 * of document, read live from the Paperless mail rules, with the dated history
 * of changes to them underneath. Read-only; the rules are edited in Paperless.
 */

import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import mailRules from '../services/paperless/mailRuleService.js';
import rbac from '../config/rolePermissionsConfig.js';
import logger from '../../services/loggerService.js';

export const GUIDE_PATH = '/paperless/mail-rules';

/**
 * True when this user gets past the guide's guards: the global route check,
 * then paperlessGuard (admin or a custom grant for the route, plus the
 * documents department). Used to show links to the guide only to people who
 * can open it.
 */
export function canOpenGuide(user) {
  if (!user) return false;
  const perms = user.customPermissions || {};
  const pattern = rbac.matchRoutePattern(GUIDE_PATH);
  const roleOk = user.role === 'admin' || (perms.routes || []).includes(pattern);
  return roleOk
    && rbac.canAccessRoute(user.role, pattern, perms)
    && rbac.canAccessDepartment(user.role, 'documents', perms);
}

export const getGuide = async (req, res, next) => {
  try {
    const overview = await mailRules.getOverview();
    let history = [];
    try {
      await mdb.connect();
      const Model = mdb.PAPERLESS?.MailRuleSnapshot;
      if (Model) history = await mailRules.loadHistory(Model);
    } catch (err) {
      logger.warn(`[mailRules] history unavailable: ${err.message}`);
    }
    res.render(path.join('tailwindcss', 'paperless', 'mailRules'), {
      title: 'Where to send documents',
      overview,
      history,
      isAdmin: req.user?.role === 'admin',
    });
  } catch (err) {
    logger.error(`[mailRules] guide error: ${err.message}`);
    next(err);
  }
};

export default { GUIDE_PATH, canOpenGuide, getGuide };
