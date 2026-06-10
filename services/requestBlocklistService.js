const logger = require("./loggerService");
const { sanitize } = logger;

// Compile a list of patterns commonly used by scanners probing for PHP/WordPress/etc.
const blockPatterns = [
  // Executable/script extensions
  /\.(php|asp|aspx|cgi|pl)(\?.*)?$/i,
  // Common platform/app targets
  /^\/(wp-(admin|login\.php|includes|content)|wp-json|xmlrpc\.php)\b/i,
  /^\/phpmyadmin\b/i,
  /^\/(hudson|jenkins)\b/i,
  /^\/cgi-bin\//i,
  // VCS and secrets
  /^\/(\.env(\..*)?|\.git|\.hg|\.bzr|\.svn)(?:\b|\/)$/i,
  /^\/(\.env(\..*)?|\.git|\.hg|\.bzr|\.svn)\//i,
  /^\/(\.htaccess|\.htpasswd)(\?.*)?$/i,
  // Vendor, test harnesses
  /^\/vendor\//i,
  /\/vendor\/phpunit\//i,
  // Well-known but executable
  /^\/\.well-known\/.*\.(php|cgi|pl)$/i,
  // Sensitive configs and lockfiles at root
  /^\/(composer\.(json|lock)|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/i,
  // Backups and dumps
  /\.(sql|tar|gz|zip|7z|rar|bak|old|swp|orig)(\?.*)?$/i,
  /\/(backup|backups|dump|database|db|sql)\b/i,
  // Specific known probe filenames
  /^\/(info|shell|hudson|z|kk|x4|rsnu|ee|3|10|456|bless3)\.php$/i,
];

// Query and path heuristics (simple WAF-like checks)
const blockHeuristics = (req) => {
  try {
    const url = (req.originalUrl || req.url || "").toLowerCase();
    // Directory traversal
    if (
      url.includes("..") ||
      url.includes("%2e%2e") ||
      url.includes("%252e%252e")
    )
      return true;
    // Basic SQLi/XSS probes
    const qs = req.url.split("?")[1] || "";
    const qsl = qs.toLowerCase();
    const badFragments = [
      "union select",
      "sleep(",
      "benchmark(",
      "load_file(",
      "outfile",
      "or 1=1",
      "<script",
      "onerror=",
      "javascript:",
      "data:text/html",
    ];
    if (badFragments.some((f) => qsl.includes(f))) return true;
    // POST/PUT/PATCH/DELETE to bare root — no legitimate browser does this
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      (req.path === "/" || req.path === "")
    )
      return true;
    return false;
  } catch (_) {
    return false;
  }
};

// Optional: allow comma-separated IPs to be blocked via env
const parseList = (s) =>
  (s || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const blockedIPs = new Set(parseList(process.env.BLOCKED_IPS));

// Temporary autoban config
const HIT_WINDOW_MS = Number(process.env.BLOCK_HIT_WINDOW_MS || 5 * 60 * 1000); // 5 minutes
const HIT_THRESHOLD = Number(process.env.BLOCK_HIT_THRESHOLD || 10);
const BAN_TTL_MS = Number(process.env.BLOCK_BAN_TTL_MS || 60 * 60 * 1000); // 1 hour

// In-memory counters and bans
const hitCounters = new Map(); // ip -> { firstTs, hits }
const bans = new Map();      // ip -> untilTs
const banStats = new Map();  // ip -> { count, firstPath } — requests blocked during active ban

module.exports = function requestBlocklistService(req, res, next) {
  try {
    // Allow health probes through
    if (req.path === "/healthz") return next();

    const p = (req.path || "").trim();

    // IP resolution (from proxy), take first IP if a list, strip port if any
    const xf = req.headers["x-forwarded-for"] || "";
    const remote = Array.isArray(xf) ? xf[0] : String(xf).split(",")[0];
    const ipPort = (remote || req.socket?.remoteAddress || "")
      .replace(/^::ffff:/, "")
      .trim();
    const ip =
      ipPort.includes(":") && ipPort.includes(".")
        ? ipPort.split(":")[0]
        : ipPort; // strip :port for IPv4:port

    // Active ban?
    const now = Date.now();
    const banUntil = bans.get(ip);
    if (banUntil && banUntil > now) {
      // Suppress per-request noise — count silently instead
      const stat = banStats.get(ip) || { count: 0, firstPath: p };
      stat.count += 1;
      banStats.set(ip, stat);
      return deny(res);
    } else if (banUntil && banUntil <= now) {
      bans.delete(ip);
      // Emit a single summary now that the ban has expired
      const stat = banStats.get(ip);
      if (stat) {
        logger.warn(
          `[blocklist] ban expired ip=${sanitize(ip)} blocked=${stat.count} requests during ban period`,
        );
        banStats.delete(ip);
      }
    }

    // IP-based blocklist (static)
    if (ip && blockedIPs.has(ip)) {
      return deny(res);
    }

    // Path-based blocking
    let matched = false;
    for (const rx of blockPatterns) {
      if (rx.test(p)) {
        matched = true;
        break;
      }
    }
    if (!matched && blockHeuristics(req)) matched = true;

    if (matched) {
      logger.warn(`[blocklist] blocked request path=${sanitize(p)} ip=${sanitize(ip)}`);
      // Update hit counters for autoban
      if (ip) {
        const entry = hitCounters.get(ip) || { firstTs: now, hits: 0 };
        // Reset window if expired
        if (now - entry.firstTs > HIT_WINDOW_MS) {
          entry.firstTs = now;
          entry.hits = 0;
        }
        entry.hits += 1;
        hitCounters.set(ip, entry);
        if (entry.hits >= HIT_THRESHOLD) {
          const until = now + BAN_TTL_MS;
          bans.set(ip, until);
          hitCounters.delete(ip);
          logger.warn(
            `[blocklist] autoban applied ip=${sanitize(ip)} until=${new Date(until).toISOString()}`,
          );
        }
      }
      return deny(res);
    }

    return next();
  } catch (err) {
    // Fail-open: don't block legitimate traffic if middleware errors
    return next();
  }
};

function deny(res) {
  try {
    res.setHeader("Connection", "close");
    res.status(403).type("text/plain").send("Forbidden");
  } catch (_) {
    try {
      res.end();
    } catch (__) {}
  }
}
