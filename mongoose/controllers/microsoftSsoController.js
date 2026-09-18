// mongoose/controllers/microsoftSsoController.js
//
// Microsoft Entra sign-in endpoints. Sign-IN only: an authenticated Microsoft
// email must already belong to an hcs-app account, otherwise the sign-in is
// refused. No account is created here.

import msSso from '../../services/microsoftSsoService.js';
import authSession from '../../services/authSessionService.js';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import auditLog from '../../services/auditLogService.js';
import { getClientIp } from '../../services/ipService.js';

// Only allow same-origin, absolute internal paths as a post-login redirect
// (mirrors getSafeNext in userCRUDController — no protocol-relative "//host").
function safeNext(value) {
  const v = String(value || '');
  return /^\/(?!\/)/.test(v) ? v : null;
}

/** GET /auth/microsoft — begin the OIDC flow. */
export const start = (req, res) => {
  if (!msSso.isEnabled()) {
    req.flash('error', 'Microsoft sign-in is not enabled.');
    return res.redirect('/user/login');
  }
  try {
    const next = safeNext(req.query.next);
    const url = msSso.buildAuthUrl(req, next);
    // Persist the state/nonce/verifier before redirecting away.
    req.session.save((err) => {
      if (err) {
        logger.error(`[msSso] could not save session before redirect: ${err.message}`);
        req.flash('error', 'Could not start Microsoft sign-in. Please try again.');
        return res.redirect('/user/login');
      }
      return res.redirect(url);
    });
  } catch (e) {
    logger.error(`[msSso] start failed: ${e.message}`);
    req.flash('error', 'Could not start Microsoft sign-in. Please try again.');
    return res.redirect('/user/login');
  }
};

/** GET /auth/microsoft/callback — complete the flow and establish a session. */
export const callback = async (req, res) => {
  if (!msSso.isEnabled()) return res.redirect('/user/login');

  const ip = getClientIp(req);
  const agent = req.useragent || {};

  try {
    if (req.query.error) {
      throw new Error(req.query.error_description || req.query.error);
    }

    const { email, next } = await msSso.exchangeAndVerify(req, {
      code: req.query.code,
      state: req.query.state,
    });

    await mdb.connect();
    const User = mdb.INTERNAL.user;
    // Case-insensitive exact match on the stored email.
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({ email: new RegExp(`^${escaped}$`, 'i') });

    if (!user) {
      // Sign-IN only — never provision. Refuse and tell the user to ask an admin.
      auditLog.record('login_failed', req, {
        username: email,
        meta: { method: 'microsoft-sso', reason: 'no-linked-account' },
      });
      logger.warn(`[msSso] refused sign-in for ${email} — no hcs-app account`);
      // Generic message — don't reveal whether an account exists for this
      // address (account enumeration). The real reason is in the logs/audit.
      req.flash('error', 'Microsoft sign-in failed. Please contact your administrator.');
      return res.redirect('/user/login');
    }

    const dest = safeNext(next);
    const sessionData = authSession.buildSessionData(user, { ip, agent, next: dest });

    // Honour the app's own 2FA exactly as password login does: stage the session
    // and divert to the 2FA page when TOTP is enabled.
    if (user.totpEnabled) {
      req.session.userPending2FA = sessionData;
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
      logger.info(`[msSso] sign-in staged for 2FA: ${user.username}`);
      return res.redirect('/user/2fa');
    }

    await authSession.establishSession(req, user, sessionData);
    auditLog.record('login_success', req, {
      userId: user._id,
      username: user.username,
      meta: { method: 'microsoft-sso' },
    });
    logger.info(`[msSso] ${user.username} signed in via Microsoft`);
    req.flash('success', `${user.username}, you're signed in with Microsoft.`);
    return res.redirect(dest || '/');
  } catch (e) {
    logger.warn(`[msSso] callback failed: ${e.message}`);
    // Don't surface the raw error to the user — it can leak internal detail.
    req.flash('error', 'Microsoft sign-in failed. Please try again.');
    return res.redirect('/user/login');
  }
};

export default { start, callback };
