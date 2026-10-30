/**
 * mailRuleController.js — GET /paperless/mail-rules: where to email each kind
 * of document, read live from the Paperless mail rules, with the dated history
 * of changes to them underneath. Read-only; the rules are edited in Paperless.
 */

import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import mailRules from '../services/paperless/mailRuleService.js';
import logger from '../../services/loggerService.js';

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

export default { getGuide };
