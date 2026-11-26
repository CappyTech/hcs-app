/**
 * Admin: clear someone's two-factor sign-in — their authenticator app (TOTP
 * secret + backup codes) and/or their passkeys. For a person who has lost the
 * device and can't get past the 2FA step.
 *
 * Admin only (adminRoutes.js), shown on the user edit page. The admin confirms
 * with their OWN password, because this removes a protection from an account.
 * The person keeps their password; if a role they hold requires 2FA they are
 * sent to Account Settings to set it up again the next time they sign in.
 */
import bcrypt from 'bcrypt';
import mdb from '../services/mongooseDatabaseService.js';
import auditLog from '../../services/auditLogService.js';
import logger from '../../services/loggerService.js';
import { parseFlag } from './userRolesController.js';

/**
 * Clear the ticked factors from `user` in place. Returns what was cleared.
 * Exported for tests.
 */
export function clearFactors(user, { totp, passkeys }) {
  const cleared = { totp: false, passkeys: 0 };
  if (totp && (user.totpEnabled || user.totpSecret || (user.totpBackupCodes || []).length)) {
    user.totpEnabled = false;
    user.totpSecret = undefined;
    user.totpBackupCodes = [];
    cleared.totp = true;
  }
  if (passkeys && Array.isArray(user.passkeys) && user.passkeys.length) {
    cleared.passkeys = user.passkeys.length;
    user.passkeys = [];
  }
  return cleared;
}

export const postClearTwoFactor = async (req, res, next) => {
  const { uuid } = req.params;
  const back = `/user/update/${encodeURIComponent(uuid)}#sign-in-security`;
  try {
    const totp = parseFlag(req.body?.totp);
    const passkeys = parseFlag(req.body?.passkeys);
    if (!totp && !passkeys) {
      req.flash('error', 'Tick the authenticator app, the passkeys, or both.');
      return res.redirect(back);
    }

    const admin = await mdb.INTERNAL.user.findById(req.session.user.id);
    const confirm = String(req.body?.confirmPassword || '');
    const ok = !!confirm && typeof admin?.password === 'string' && (await bcrypt.compare(confirm, admin.password));
    if (!ok) {
      req.flash('error', 'Your password was wrong. Nothing was cleared.');
      return res.redirect(back);
    }

    const user = await mdb.INTERNAL.user.findOne({ uuid: String(uuid) }, null, { sanitizeFilter: true });
    if (!user) {
      return next({ statusCode: 404, name: 'NotFoundError', message: 'User not found.' });
    }

    const cleared = clearFactors(user, { totp, passkeys });
    if (!cleared.totp && !cleared.passkeys) {
      req.flash('info', `${user.username} had nothing of that set up. Nothing was cleared.`);
      return res.redirect(back);
    }
    await user.save();

    const meta = { byAdmin: req.session.user.username };
    if (cleared.totp) auditLog.record('totp_disabled', req, { userId: user._id, username: user.username, meta });
    if (cleared.passkeys) {
      auditLog.record('passkey_removed', req, { userId: user._id, username: user.username, meta: { ...meta, all: true, count: cleared.passkeys } });
    }
    logger.warn(`[admin] ${req.session.user.username} cleared 2FA for ${user.username}: totp=${cleared.totp} passkeys=${cleared.passkeys}`);

    const parts = [];
    if (cleared.totp) parts.push('authenticator app and backup codes');
    if (cleared.passkeys) parts.push(`${cleared.passkeys} passkey${cleared.passkeys === 1 ? '' : 's'}`);
    req.flash('success', `Cleared ${user.username}'s ${parts.join(' and ')}. They can sign in with their password and set up two-factor again.`);
    return res.redirect(back);
  } catch (err) {
    return next(err);
  }
};

export default { postClearTwoFactor, clearFactors };
