/**
 * cookieNameService — the names of the two cookies this app sets, in one place.
 *
 * They were hardcoded in five files, including `res.clearCookie("hms.sid")` at
 * logout, so any rename would silently stop logout clearing the cookie.
 *
 * The names carry a **cookie prefix** when the deployment can guarantee one is
 * valid. The prefixes are enforced by the browser, not by us:
 *
 *   `__Host-`   requires Secure, Path=/, and NO Domain attribute. A cookie so
 *               named cannot be set by a subdomain, or over plain HTTP, or with
 *               a wider Domain — which is what makes it worth having: it closes
 *               subdomain cookie-fixation, and `heroncs.co.uk` has several other
 *               subdomains on the same edge.
 *   `__Secure-` requires Secure only. Used when a cookie domain is configured,
 *               since `__Host-` forbids one.
 *
 * A browser **rejects** a prefixed cookie that does not meet the rules, and
 * rejects it silently — the login form would simply never log anyone in. So the
 * prefix is applied only when this process knows every response will be Secure:
 * `COOKIE_SECURE=true`, or `TRUST_EDGE_TLS=true`, which makes every request read
 * as HTTPS. Under the default `auto`, secure is decided per request and cannot
 * be promised at the time the cookie is named, so the bare name is used.
 */

export const SESSION_COOKIE_BASE = 'hms.sid';
export const CSRF_COOKIE_BASE = 'hms.csrf';

function truthy(value) {
  return String(value || '').toLowerCase() === 'true';
}

/**
 * The prefix this deployment can use: '__Host-', '__Secure-' or ''.
 * Reads the environment each call so a settings change is picked up on the next
 * process start — the names themselves must not move under a live session.
 */
export function cookiePrefix() {
  const cookieSecureEnv = String(process.env.COOKIE_SECURE || '').toLowerCase();
  if (cookieSecureEnv === 'false') return '';
  const alwaysSecure = cookieSecureEnv === 'true' || truthy(process.env.TRUST_EDGE_TLS);
  if (!alwaysSecure) return '';
  return process.env.SESSION_COOKIE_DOMAIN ? '__Secure-' : '__Host-';
}

export function sessionCookieName() {
  return cookiePrefix() + SESSION_COOKIE_BASE;
}

export function csrfCookieName() {
  return cookiePrefix() + CSRF_COOKIE_BASE;
}

/**
 * Every name a cookie may have been set under, so logout can clear the one in
 * the browser now as well as the one from before a prefix was adopted. Clearing
 * a name that was never set is a no-op.
 */
export function allSessionCookieNames() {
  return [...new Set([sessionCookieName(), SESSION_COOKIE_BASE, `__Host-${SESSION_COOKIE_BASE}`, `__Secure-${SESSION_COOKIE_BASE}`])];
}

export function allCsrfCookieNames() {
  return [...new Set([csrfCookieName(), CSRF_COOKIE_BASE, `__Host-${CSRF_COOKIE_BASE}`, `__Secure-${CSRF_COOKIE_BASE}`])];
}

export default {
  SESSION_COOKIE_BASE,
  CSRF_COOKIE_BASE,
  cookiePrefix,
  sessionCookieName,
  csrfCookieName,
  allSessionCookieNames,
  allCsrfCookieNames,
};
