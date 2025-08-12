const crypto = require('crypto');
const logger = require('./loggerService');

// Lightweight CSRF middleware (transitional mode by default).
// Generates a per-session token and validates non-idempotent methods.
// Accepts token in body._csrf / body.csrfToken / X-CSRF-Token header / ?_csrf query.
// STRICT_MODE=true enforces rejection; otherwise logs and allows (grace period to update forms).

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Optional comma separated path prefixes to exempt (e.g. "/user/login,/user/register")
const EXEMPT = (process.env.CSRF_EXEMPT_PATHS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

module.exports = function csrfService(req, res, next) {
  try {
    if (!req.session) return next();

    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;

    if (SAFE_METHODS.has(req.method)) return next();

    // Exempt explicit paths (prefix match) to unblock critical flows during debugging
    if (EXEMPT.length && EXEMPT.some(p => req.path.startsWith(p))) {
      logger.warn(`CSRF exempt path allowed method=${req.method} path=${req.originalUrl}`);
      return next();
    }

    const supplied = (req.body && (req.body._csrf || req.body.csrfToken))
      || req.headers['x-csrf-token']
      || req.query._csrf;

  if (supplied && supplied === req.session.csrfToken) return next();

    const strict = process.env.STRICT_MODE === 'true';
    if (strict) {
      const exp = req.session.csrfToken || 'none';
      const ob = v => v ? `${v.slice(0,8)}...${v.slice(-6)}(len=${v.length})` : 'null';
      logger.warn(`CSRF blocked: ${req.method} ${req.originalUrl} supplied=${ob(supplied)} expected=${ob(exp)} hasSession=${!!req.sessionID}`);
      return res.status(403).send('Forbidden (CSRF)');
    } else {
      const exp = req.session.csrfToken || 'none';
      const ob = v => v ? `${v.slice(0,8)}...${v.slice(-6)}(len=${v.length})` : 'null';
      logger.warn(`CSRF missing/mismatch (allowed transitional) for ${req.method} ${req.originalUrl} supplied=${ob(supplied)} expected=${ob(exp)}`);
      return next();
    }
  } catch (err) {
    logger.error('CSRF middleware error: ' + err.message);
    next();
  }
};
