const crypto = require("crypto");
const logger = require("./loggerService");
const { sanitize } = logger;

// Lightweight CSRF middleware (strict mode by default).
// Generates a per-session token and validates non-idempotent methods.
// Accepts token in body._csrf / body.csrfToken / X-CSRF-Token / X-XSRF-Token header.
// Validation compares against the SESSION token only (timing-safe); the cookie is
// a read-only convenience copy for JS clients that echo it back in a header.
// STRICT_MODE=false downgrades rejection to a logged warning (transitional mode
// for updating legacy forms).
//
// For multipart/form-data routes (file uploads using multer), the request body is not
// parsed at the point this global middleware runs. Those routes must use csrfService.validate
// as a per-route middleware AFTER their multer middleware so the token can be read from
// the parsed body.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const CSRF_COOKIE_NAME = "hms.csrf";

// Optional comma separated path prefixes to exempt (e.g. "/user/login,/user/register")
// Built-in exemptions cover machine-to-machine API endpoints that authenticate via
// their own headers (e.g. X-Sync-Api-Key) and never carry a browser CSRF token.
const BUILTIN_EXEMPT = ["/api/sso/token"];
const EXEMPT = BUILTIN_EXEMPT.concat(
  (process.env.CSRF_EXEMPT_PATHS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Exempt entries match the exact path or a path-segment prefix
// ("/api/sso/token" matches "/api/sso/token" and "/api/sso/token/x",
// but NOT "/api/sso/tokenx").
function isExemptPath(reqPath) {
  return EXEMPT.some((p) => reqPath === p || reqPath.startsWith(p + "/"));
}

function tokensMatch(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") return false;
  if (!supplied || !expected) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const ha = crypto.createHash("sha256").update(supplied).digest();
  const hb = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = function csrfService(req, res, next) {
  try {
    if (!req.session) return next();
    let createdToken = false;
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString("hex");
      createdToken = true;
    }
    // The session token is the single source of truth.
    res.locals.csrfToken = req.session.csrfToken;

    // Set a readable cookie mirroring the session token so JS clients can echo
    // it back in X-CSRF-Token. The cookie is never accepted as the expected
    // value during validation — only the session token is.
    try {
      res.cookie(CSRF_COOKIE_NAME, req.session.csrfToken, {
        httpOnly: false,
        sameSite: "lax",
        secure: !!req.secure,
        path: "/",
      });
    } catch (_) {}
    // Ensure the session cookie is set on first interaction
    if (createdToken) {
      try {
        // Non-blocking save; cookie will be sent with response
        req.session.save(() => {});
      } catch (_) {}
    }

    if (SAFE_METHODS.has(req.method)) return next();

    // Exempt explicit paths to unblock machine-to-machine flows
    if (isExemptPath(req.path)) {
      logger.warn(
        `CSRF exempt path allowed method=${sanitize(req.method)} path=${sanitize(req.originalUrl)}`,
      );
      return next();
    }

    // Multipart requests: the body hasn't been parsed yet at this point (multer runs later
    // in the route handler). Validation is deferred to csrfService.validate which must be
    // placed after the multer middleware in those routes.
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
      return next();
    }

    return validateToken(req, res, next);
  } catch (err) {
    logger.error("CSRF middleware error: " + err.message);
    next();
  }
};

// Per-route CSRF validation for use after multer (or any middleware that parses multipart
// body). Add this as a middleware in route arrays after your upload middleware:
//   router.post('/upload', upload.single('file'), csrfService.validate, handler)
module.exports.validate = function validateCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  try {
    return validateToken(req, res, next);
  } catch (err) {
    logger.error("CSRF validate middleware error: " + err.message);
    next();
  }
};

function validateToken(req, res, next) {
    // Token may arrive in the body or a header. The query string is NOT
    // accepted: tokens in URLs leak via logs and Referer headers.
    const supplied =
      (req.body && (req.body._csrf || req.body.csrfToken)) ||
      req.headers["x-csrf-token"] ||
      req.headers["x-xsrf-token"];

    const expected = req.session && req.session.csrfToken;
    if (tokensMatch(supplied, expected)) return next();

    const strict = process.env.STRICT_MODE !== "false";
    const ob = (v) =>
      v ? `${v.slice(0, 8)}...${v.slice(-6)}(len=${v.length})` : "null";
    if (strict) {
      logger.warn(
        `CSRF blocked: ${sanitize(req.method)} ${sanitize(req.originalUrl)} supplied=${ob(supplied)} expected=${ob(expected || "none")} hasSession=${!!(req.sessionID)}`,
      );
      return res.status(403).send("Forbidden (CSRF)");
    } else {
      logger.warn(
        `CSRF missing/mismatch (allowed transitional) for ${sanitize(req.method)} ${sanitize(req.originalUrl)} supplied=${ob(supplied)} expected=${ob(expected || "none")}`,
      );
      return next();
    }
}
