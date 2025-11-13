const logger = require('./loggerService');

// Compile a list of patterns commonly used by scanners probing for PHP/WordPress/etc.
const blockPatterns = [
  /\.(php|asp|aspx|cgi|pl)(\?.*)?$/i,
  /^\/wp-(admin|login\.php|includes|content)\b/i,
  /^\/phpmyadmin\b/i,
  /^\/vendor\//i,
  /^\/\.env\b/i,
  /^\/\.git\b/i,
  /^\/\.svn\b/i,
  /^\/\.well-known\/.*\.(php|cgi|pl)$/i,
  /^\/info\.php$/i,
  /^\/shell\.php$/i,
  /^\/hudson\b/i,
  /^\/\.DS_Store$/i
];

// Optional: allow comma-separated IPs to be blocked via env
const parseList = (s) => (s || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const blockedIPs = new Set(parseList(process.env.BLOCKED_IPS));

module.exports = function requestBlocklistService(req, res, next) {
  try {
    const p = (req.path || '').trim();

    // IP-based blocklist (optional)
    const xf = req.headers['x-forwarded-for'] || '';
    const remote = Array.isArray(xf) ? xf[0] : String(xf);
    const ip = (remote || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip && blockedIPs.has(ip)) {
      return deny(res);
    }

    // Path-based blocking
    for (const rx of blockPatterns) {
      if (rx.test(p)) {
        // Log once per request at warn level
        logger.warn(`[blocklist] blocked request path=${p} ip=${ip}`);
        return deny(res);
      }
    }

    return next();
  } catch (err) {
    // Fail-open: don't block legitimate traffic if middleware errors
    return next();
  }
};

function deny(res) {
  try {
    res.setHeader('Connection', 'close');
    res.status(403).type('text/plain').send('Forbidden');
  } catch (_) {
    try { res.end(); } catch (__) {}
  }
}
