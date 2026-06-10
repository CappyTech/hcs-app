const crypto = require("crypto");
const logger = require("./loggerService");

// Lightweight CSRF middleware (transitional mode by default).
// Generates a per-session token and validates non-idempotent methods.
// Accepts token in body._csrf / body.csrfToken / X-CSRF-Token header / ?_csrf query.
// STRICT_MODE=true enforces rejection; otherwise logs and allows (grace period to update forms).
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

module.exports = function csrfService(req, res, next) {
  try {
    if (!req.session) return next();
    let createdToken = false;
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString("hex");
      createdToken = true;
    }
    // Prefer an existing CSRF cookie (supports cases where the session cookie isn't
    // sent back due to proxy/secure-cookie mismatches), otherwise fall back to session.
    const cookieToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
    res.locals.csrfToken = cookieToken || req.session.csrfToken;

    // Always set a CSRF cookie to support double-submit style validation.
    // - SameSite=Lax prevents cross-site POSTs from including this cookie.
    // - We tie "secure" to req.secure so it still works behind imperfect proxy headers.
    try {
      res.cookie(CSRF_COOKIE_NAME, res.locals.csrfToken, {
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

    // Exempt explicit paths (prefix match) to unblock critical flows during debugging
    if (EXEMPT.length && EXEMPT.some((p) => req.path.startsWith(p))) {
      logger.warn(
        `CSRF exempt path allowed method=${req.method} path=${req.originalUrl}`,
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
    const supplied =
      (req.body && (req.body._csrf || req.body.csrfToken)) ||
      req.headers["x-csrf-token"] ||
      req.headers["x-xsrf-token"] ||
      req.query._csrf;

    const expectedSession = req.session && req.session.csrfToken;
    const expectedCookie = req.cookies && req.cookies[CSRF_COOKIE_NAME];
    if (
      supplied &&
      (supplied === expectedSession || supplied === expectedCookie)
    )
      return next();

    const strict = process.env.STRICT_MODE === "true";
    const exp = (req.session && req.session.csrfToken) || "none";
    const ob = (v) =>
      v ? `${v.slice(0, 8)}...${v.slice(-6)}(len=${v.length})` : "null";
    if (strict) {
      logger.warn(
        `CSRF blocked: ${req.method} ${req.originalUrl} supplied=${ob(supplied)} expected=${ob(exp)} hasSession=${!!(req.sessionID)}`,
      );
      return res.status(403).send("Forbidden (CSRF)");
    } else {
      logger.warn(
        `CSRF missing/mismatch (allowed transitional) for ${req.method} ${req.originalUrl} supplied=${ob(supplied)} expected=${ob(exp)}`,
      );
      return next();
    }
}
