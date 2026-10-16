/**
 * turnstileService — Cloudflare Turnstile for the login and registration forms.
 *
 * The CAPTCHA is enforced only when BOTH keys are configured. A fresh
 * deployment has neither, and a login form that demands a token nobody can
 * produce would lock the first administrator out of the app they just
 * created; so until the keys are set (Admin → Configuration → Security) the
 * forms render without the widget and the controllers skip verification.
 *
 * SKIP_TURNSTILE=true is the explicit, loud bypass for local development and
 * is unchanged: it skips verification even when keys exist, and the login
 * page shows a warning banner.
 */

import axios from 'axios';
import configService from './configService.js';
import logger from './loggerService.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const str = (key) => String(configService.get(key, '') ?? '').trim();

/** The public site key the widget renders with, or '' when unset. */
export function siteKey() {
  return str('TURNSTILE_SITE_KEY');
}

/** True when the explicit development bypass is on. */
export function isBypassed() {
  return String(process.env.SKIP_TURNSTILE || '').toLowerCase() === 'true';
}

/** True when both keys are set: the widget is shown and the token is verified. */
export function isConfigured() {
  return !!(siteKey() && str('TURNSTILE_SECRET_KEY'));
}

/** True when a submitted form must carry a valid token. */
export function isRequired() {
  return isConfigured() && !isBypassed();
}

/**
 * Verify a token. Resolves to { ok, reason }. When the CAPTCHA is not
 * required the answer is ok without a network call.
 */
export async function verify(token, remoteip) {
  if (!isRequired()) return { ok: true, reason: isBypassed() ? 'bypassed' : 'not-configured' };
  if (!token) return { ok: false, reason: 'missing' };
  try {
    const { data } = await axios.post(
      VERIFY_URL,
      new URLSearchParams({ secret: str('TURNSTILE_SECRET_KEY'), response: token, remoteip }),
    );
    return data && data.success ? { ok: true, reason: 'verified' } : { ok: false, reason: 'failed' };
  } catch (err) {
    logger.error('[turnstile] siteverify request failed: ' + err.message);
    return { ok: false, reason: 'error' };
  }
}

/** What the auth views need. */
export function viewLocals() {
  return {
    siteKey: siteKey(),
    turnstileEnabled: isRequired(),
    skipTurnstile: isBypassed(),
  };
}

export default { siteKey, isBypassed, isConfigured, isRequired, verify, viewLocals };
