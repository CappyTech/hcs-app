'use strict';

/**
 * unsubscribeTokenService — stateless, signed, expiring unsubscribe tokens.
 *
 * A token is `payload.signature`, where:
 *   payload   = base64url(JSON { u: userId, s: scope, e: expiryEpochSeconds })
 *   signature = base64url(HMAC_SHA256(serverSecret, payload + '.' + userNotificationToken))
 *
 * Properties:
 *   - Tamper-proof: userId / scope / expiry can't be changed without the secret.
 *   - Expiring: `e` is enforced on verify (default 90 days).
 *   - Per-type scoped: `s` is `type:<key>` or `admin` (master admin-contact toggle),
 *     so a leaked link only affects one preference, not all of them.
 *   - Per-user revocable: the user's `notificationToken` is mixed into the HMAC
 *     key, so rotating that token (see emailPreferenceService.rotateToken)
 *     invalidates every outstanding link for that user — and only that user —
 *     without breaking anyone else's or needing to touch the server secret.
 *
 * The server secret rotates ALL users' links at once (incident-response lever);
 * per-user rotation is the everyday "my link leaked" control.
 */

const crypto = require('crypto');
const configService = require('../../services/configService');
const mdb = require('./mongooseDatabaseService');

const DEFAULT_TTL_DAYS = 90;

function serverSecret() {
  // Prefer a dedicated secret; otherwise reuse an existing stable server secret
  // so this works with no extra configuration. Never falls back to a constant.
  const s = configService.get('UNSUBSCRIBE_SECRET')
    || configService.get('SESSION_SECRET')
    || configService.get('ENCRYPTION_KEY');
  if (!s) throw new Error('unsubscribeTokenService: no server secret available (set UNSUBSCRIBE_SECRET or SESSION_SECRET).');
  return String(s);
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function computeSig(payload, notificationToken) {
  return b64urlEncode(
    crypto.createHmac('sha256', serverSecret()).update(`${payload}.${notificationToken || ''}`).digest(),
  );
}

/**
 * Build a signed token.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.scope  'type:<key>' | 'admin'
 * @param {string} opts.notificationToken  the user's current notificationToken
 * @param {number} [opts.ttlDays]
 * @returns {string}
 */
function sign({ userId, scope, notificationToken, ttlDays = DEFAULT_TTL_DAYS }) {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  const payload = b64urlEncode(JSON.stringify({ u: String(userId), s: String(scope), e: exp }));
  return `${payload}.${computeSig(payload, notificationToken)}`;
}

/**
 * Verify a token and load its user. Recomputes the signature against the user's
 * CURRENT notificationToken, so a rotated token fails with reason 'bad-signature'.
 *
 * @returns {Promise<{ ok: true, user: object, scope: string }
 *   | { ok: false, reason: 'malformed'|'expired'|'unknown-user'|'bad-signature'|'unavailable' }>}
 *
 * 'expired' and 'bad-signature' both mean a structurally-valid token that no
 * longer validates — i.e. it was rotated or timed out — which the caller can
 * surface as a friendly "your link was rotated, please log in" page.
 */
async function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return { ok: false, reason: 'malformed' };

  let data;
  try {
    data = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch (_) { return { ok: false, reason: 'malformed' }; }
  if (!data || !data.u || !data.s || !data.e) return { ok: false, reason: 'malformed' };
  if (Number(data.e) * 1000 < Date.now()) return { ok: false, reason: 'expired' };

  const User = mdb.INTERNAL && mdb.INTERNAL.user;
  if (!User) return { ok: false, reason: 'unavailable' };
  let user;
  try {
    user = await User.findById(data.u).lean();
  } catch (_) { return { ok: false, reason: 'malformed' }; }
  if (!user) return { ok: false, reason: 'unknown-user' };

  const expected = computeSig(payload, user.notificationToken);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  return { ok: true, user, scope: String(data.s) };
}

/** Parse a scope string into a structured decision for the handler. */
function parseScope(scope) {
  if (scope === 'admin') return { kind: 'admin-contact' };
  if (scope && scope.startsWith('type:')) return { kind: 'type', typeKey: scope.slice(5) };
  return { kind: 'unknown' };
}

module.exports = { sign, verify, parseScope, DEFAULT_TTL_DAYS };
