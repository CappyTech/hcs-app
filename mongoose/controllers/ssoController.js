const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../../services/loggerService');

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
  if (allowHttp && protocol === 'http:') return true;
  return false;
}

exports.hcsSyncHandoff = async (req, res) => {
  const returnTo = parseReturnTo(req.query?.return_to);

  // Not authenticated → bounce to login (internal next only).
  if (!req.user) {
    const internalNext = buildInternalLoginNext(returnTo ? returnTo.toString() : '');
    return res.redirect('/user/login?next=' + encodeURIComponent(internalNext));
  }

  // Validate return_to to prevent open redirects.
  if (!returnTo || !isAllowedReturnTo(returnTo)) {
    return res.status(400).send('Invalid return URL');
  }

  const secret = process.env.HCS_SSO_JWT_SECRET;
  if (!secret) {
    logger.error('[sso] HCS_SSO_JWT_SECRET missing');
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

  res.cookie('hcs_sso', token, {
    httpOnly: true,
    secure: getCookieSecure(req),
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSec * 1000,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });

  return res.redirect(returnTo.toString());
};
