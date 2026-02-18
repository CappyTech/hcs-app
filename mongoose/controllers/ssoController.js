const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../../services/loggerService');

function isLocalhostHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h === '::1') return true;
  return false;
}

function getCookieSecure(req) {
  const env = String(process.env.COOKIE_SECURE || '').toLowerCase();
  if (env === 'true') return true;
  if (env === 'false') return false;
  // Auto: only set Secure when request is HTTPS (works behind proxies if trust proxy is set)
  return Boolean(req.secure);
}

function buildInternalLoginNext(returnTo) {
  const url = new URL('https://app.invalid/sso/hcs-sync');
  if (returnTo) url.searchParams.set('return_to', returnTo);
  return url.pathname + url.search;
}

function parseReturnTo(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u;
  } catch {
    return null;
  }
}

function isAllowedReturnTo(urlObj) {
  const allowList = String(process.env.HCS_SSO_RETURN_HOSTS || 'sync.heroncs.co.uk')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const host = String(urlObj.hostname || '').toLowerCase();
  if (!allowList.includes(host)) return false;

  const protocol = String(urlObj.protocol || '').toLowerCase();
  const allowHttp = String(process.env.HCS_SSO_ALLOW_HTTP || '').toLowerCase() === 'true';
  if (protocol === 'https:') return true;
  if (isLocalhostHostname(host) && protocol === 'http:') return true;
  if (allowHttp && protocol === 'http:') return true;
  return false;
}

function upgradeReturnToToHttpsIfAllowed(urlObj) {
  if (!urlObj) return null;

  // If the target host is allowlisted but proto is http (common when upstream
  // loses X-Forwarded-Proto), upgrade to https rather than rejecting.
  try {
    const hostAllowList = String(process.env.HCS_SSO_RETURN_HOSTS || 'sync.heroncs.co.uk')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const host = String(urlObj.hostname || '').toLowerCase();
    const proto = String(urlObj.protocol || '').toLowerCase();

    // Local development: if return host is localhost/loopback, prefer plain HTTP.
    if (isLocalhostHostname(host)) {
      urlObj.protocol = 'http:';
      return urlObj;
    }

    const allowHttp = String(process.env.HCS_SSO_ALLOW_HTTP || '').toLowerCase() === 'true';
    if (proto === 'http:' && !allowHttp && hostAllowList.includes(host)) {
      urlObj.protocol = 'https:';
    }
  } catch {
    // ignore
  }

  return urlObj;
}

exports.hcsSyncHandoff = async (req, res) => {
  const returnTo = upgradeReturnToToHttpsIfAllowed(parseReturnTo(req.query?.return_to));

  // Not authenticated → bounce to login (internal next only).
  if (!req.user) {
    const internalNext = buildInternalLoginNext(returnTo ? returnTo.toString() : '');
    return res.redirect('/user/login?next=' + encodeURIComponent(internalNext));
  }

  // Validate return_to to prevent open redirects.
  if (!returnTo || !isAllowedReturnTo(returnTo)) {
    return res.status(400).send('Invalid return URL');
  }

  const secret = process.env.HCS_SSO_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    logger.error('[sso] HCS_SSO_JWT_SECRET (and JWT_SECRET fallback) missing – cannot sign SSO token');
    return res.status(500).send('SSO not configured');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Number(process.env.HCS_SSO_TTL_SECONDS || 60 * 60 * 8);

  const token = jwt.sign(
    {
      sub: req.user._id.toString(),
      username: req.user.username,
      role: req.user.role,
      iss: 'hcs-app',
      aud: 'hcs-sync',
      iat: nowSec,
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: ttlSec,
      jwtid: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    }
  );

  const cookieDomain = String(process.env.HCS_SSO_COOKIE_DOMAIN || process.env.SESSION_COOKIE_DOMAIN || '').trim();

  // Derive a shared parent domain when no explicit cookie domain is configured.
  // e.g. app.heroncs.co.uk + sync.heroncs.co.uk → .heroncs.co.uk
  let effectiveDomain = cookieDomain;
  if (!effectiveDomain) {
    try {
      const appHost = (req.hostname || req.headers?.host || '').split(':')[0].toLowerCase();
      const targetHost = String(returnTo.hostname || '').toLowerCase();
      if (appHost && targetHost && appHost !== targetHost) {
        const appParts = appHost.split('.');
        const targetParts = targetHost.split('.');
        const common = [];
        while (appParts.length && targetParts.length &&
               appParts[appParts.length - 1] === targetParts[targetParts.length - 1]) {
          common.unshift(appParts.pop());
          targetParts.pop();
        }
        // Need at least a registrable domain (e.g. heroncs.co.uk → 3 labels)
        if (common.length >= 2) {
          effectiveDomain = '.' + common.join('.');
          logger.info(`[sso] No explicit cookie domain; derived "${effectiveDomain}" from ${appHost} ↔ ${targetHost}`);
        }
      }
    } catch (_) { /* ignore derivation errors */ }
  }

  res.cookie('hcs_sso', token, {
    httpOnly: true,
    secure: getCookieSecure(req),
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSec * 1000,
    ...(effectiveDomain ? { domain: effectiveDomain } : {}),
  });

  return res.redirect(returnTo.toString());
};
