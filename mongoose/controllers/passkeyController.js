/**
 * passkeyController — JSON endpoints behind public/js/passkeys.js.
 *
 * Three flows:
 *   1. Sign in with a passkey from the login page (no username, no password).
 *   2. Use a passkey at the two-factor step after a password — offered before
 *      the authenticator-app code.
 *   3. Add / remove passkeys from Account Settings.
 *
 * Every response is JSON: { ok, redirect? , error? }. The browser script
 * follows `redirect`; flash messages are set server-side so they appear on
 * the page it lands on.
 */
import bcrypt from 'bcrypt';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import auditLog from '../../services/auditLogService.js';
import passkeys from '../../services/passkeyService.js';
import { completeLogin } from '../../services/loginSessionService.js';

function getSafeNext(raw) {
  const v = String(raw || '').trim();
  if (!v || v.length > 2000) return null;
  if (v.includes('\n') || v.includes('\r') || v.includes('\\')) return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  if (v.split('?')[0].includes('://')) return null;
  return v;
}

function fail(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

function findByCredential(credentialId) {
  return mdb.INTERNAL.user.findOne(
    { 'passkeys.credentialId': String(credentialId) },
    null,
    { sanitizeFilter: true },
  );
}

function lockedMessage(user) {
  if (!user?.lockedUntil || user.lockedUntil <= new Date()) return null;
  const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
  return `Account temporarily locked. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`;
}

// ── 1. Sign in with a passkey (login page) ─────────────────────────────────
// Two requests can be open on the login page at once: the browser's autofill
// list under the username box (`mode: 'autofill'`, conditional mediation) and
// the "Sign in with a passkey" button. Each keeps its own challenge so one
// doesn't overwrite the other's.

function loginKey(mode) {
  return mode === 'autofill' ? 'passkeyAutofill' : 'passkeyLogin';
}

export const loginOptions = async (req, res) => {
  try {
    if (req.session.user) return fail(res, 400, 'You are already signed in.');
    const key = loginKey(req.body?.mode);
    const options = await passkeys.authenticationOptions(req, { key });
    req.session[key].next = getSafeNext(req.body?.next);
    return res.json({ ok: true, options });
  } catch (err) {
    logger.error(`[passkey] login options failed: ${err.message}`);
    return fail(res, 500, 'Passkey sign-in is unavailable right now.');
  }
};

export const loginVerify = async (req, res) => {
  const key = loginKey(req.body?.mode);
  const next = getSafeNext(req.session?.[key]?.next);
  let user = null;
  try {
    const result = await passkeys.verifyAuthentication(req, {
      key,
      response: req.body?.response,
      findUser: findByCredential,
    });
    user = result.user;
    const locked = lockedMessage(user);
    if (locked) return fail(res, 423, locked);

    user.loginAttempts = 0;
    user.lockedUntil = null;
    await user.save();
    delete req.session.passkeyLogin;
    delete req.session.passkeyAutofill;

    auditLog.record('login_success', req, {
      userId: user._id, username: user.username,
      meta: { twoFactor: true, method: 'passkey', passkey: result.passkey.name },
    });
    await completeLogin(req, user, { tag: 'passkey' });
    logger.info(`${user.username} signed in with a passkey.`);
    req.flash('success', `${user.username}, you're logged in.`);
    return res.json({ ok: true, redirect: next || '/' });
  } catch (err) {
    logger.info(`[passkey] sign-in rejected: ${err.message}`);
    auditLog.record('login_failed', req, {
      userId: user?._id ?? null, username: user?.username ?? null,
      meta: { method: 'passkey', reason: err.message.slice(0, 120) },
    });
    return fail(res, 400, err.message || 'Passkey sign-in failed.');
  }
};

// ── 2. Passkey at the two-factor step ──────────────────────────────────────

export const twoFAOptions = async (req, res) => {
  try {
    const pending = req.session.userPending2FA;
    if (!pending) return fail(res, 401, 'Your sign-in has expired. Please log in again.');
    const user = await mdb.INTERNAL.user.findOne({ uuid: pending.uuid }, null, { sanitizeFilter: true });
    if (!passkeys.hasPasskeys(user)) return fail(res, 400, 'No passkeys are set up for this account.');
    const options = await passkeys.authenticationOptions(req, { key: 'passkey2FA', user });
    return res.json({ ok: true, options });
  } catch (err) {
    logger.error(`[passkey] 2FA options failed: ${err.message}`);
    return fail(res, 500, 'Passkey sign-in is unavailable right now.');
  }
};

export const twoFAVerify = async (req, res) => {
  const pending = req.session.userPending2FA;
  if (!pending) return fail(res, 401, 'Your sign-in has expired. Please log in again.');
  const next = getSafeNext(pending.next);
  try {
    const { user, passkey } = await passkeys.verifyAuthentication(req, {
      key: 'passkey2FA',
      response: req.body?.response,
      findUser: async (credentialId) => {
        const u = await findByCredential(credentialId);
        return u && u.uuid === pending.uuid ? u : null;
      },
    });
    await user.save();
    auditLog.record('login_success', req, {
      userId: user._id, username: user.username,
      meta: { twoFactor: true, method: 'password+passkey', passkey: passkey.name },
    });
    await completeLogin(req, user, { tag: 'passkey 2FA' });
    req.flash('success', 'Successfully logged in.');
    return res.json({ ok: true, redirect: next || '/' });
  } catch (err) {
    logger.info(`[passkey] 2FA rejected for ${pending.username}: ${err.message}`);
    return fail(res, 400, err.message || 'Passkey check failed.');
  }
};

// ── 3. Account Settings: add / remove ──────────────────────────────────────

export const registerOptions = async (req, res) => {
  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) return fail(res, 404, 'User not found.');
    if ((user.passkeys || []).length >= passkeys.MAX_PASSKEYS) {
      return fail(res, 400, `You can keep up to ${passkeys.MAX_PASSKEYS} passkeys. Remove one first.`);
    }
    const options = await passkeys.registrationOptions(req, user);
    return res.json({ ok: true, options });
  } catch (err) {
    logger.error(`[passkey] registration options failed: ${err.message}`);
    return fail(res, 500, 'Could not start adding a passkey.');
  }
};

export const registerVerify = async (req, res) => {
  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) return fail(res, 404, 'User not found.');
    const record = await passkeys.verifyRegistration(req, user, req.body?.response, req.body?.name);
    user.passkeys.push(record);
    await user.save();
    auditLog.record('passkey_added', req, {
      userId: user._id, username: user.username, meta: { name: record.name },
    });
    logger.info(`[passkey] ${user.username} added passkey "${record.name}"`);
    req.flash('success', `Passkey "${record.name}" added. You can now sign in with it.`);
    return res.json({ ok: true, redirect: '/user/account' });
  } catch (err) {
    logger.info(`[passkey] registration rejected: ${err.message}`);
    return fail(res, 400, err.message || 'The passkey could not be added.');
  }
};

// Plain form post (no JS needed) — password confirms, like disabling TOTP.
export const removePasskey = async (req, res) => {
  try {
    const credentialId = String(req.body?.credentialId || '');
    const { confirmPassword } = req.body || {};
    if (!confirmPassword) {
      req.flash('error', 'Enter your password to remove a passkey.');
      return res.redirect('/user/account');
    }
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/user/account');
    }
    const ok = typeof user.password === 'string' && (await bcrypt.compare(String(confirmPassword), user.password));
    if (!ok) {
      req.flash('error', 'Incorrect password. The passkey was not removed.');
      return res.redirect('/user/account');
    }
    const found = (user.passkeys || []).find((p) => p.credentialId === credentialId);
    if (!found) {
      req.flash('error', 'That passkey was not found on your account.');
      return res.redirect('/user/account');
    }
    user.passkeys = user.passkeys.filter((p) => p.credentialId !== credentialId);
    await user.save();
    auditLog.record('passkey_removed', req, {
      userId: user._id, username: user.username, meta: { name: found.name },
    });
    req.flash('success', `Passkey "${found.name}" removed. Also delete it from your device or password manager.`);
    return res.redirect('/user/account');
  } catch (err) {
    logger.error(`[passkey] remove failed: ${err.message}`);
    req.flash('error', 'The passkey could not be removed.');
    return res.redirect('/user/account');
  }
};

export default {
  loginOptions, loginVerify, twoFAOptions, twoFAVerify,
  registerOptions, registerVerify, removePasskey,
};
