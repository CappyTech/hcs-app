const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const totpService = require("../../services/totpService");
const logger = require("../../services/loggerService");
const mdb = require("../services/mongooseDatabaseService");
const encryptionService = require("../../services/encryptionService");

// Roles allowed to receive an hcs-sync SSO token. The sync dashboard exposes
// financial data and destructive operations (dedup, manual sync), so it is
// limited to back-office roles by default.
function getAllowedSsoRoles() {
  return String(process.env.HCS_SYNC_SSO_ROLES || "admin,accountant")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isRoleAllowedForSync(role) {
  return getAllowedSsoRoles().includes(String(role || "").toLowerCase());
}

// Timing-safe string comparison (handles differing lengths by hashing first).
function safeEqual(a, b) {
  const ha = crypto.createHmac("sha256", "hcs-sso").update(String(a)).digest();
  const hb = crypto.createHmac("sha256", "hcs-sso").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLocalhostHostname(hostname) {
  const h = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "127.0.0.1" || h === "::1") return true;
  return false;
}

function getCookieSecure(req) {
  const env = String(process.env.COOKIE_SECURE || "").toLowerCase();
  if (env === "true") return true;
  if (env === "false") return false;
  // Auto: only set Secure when request is HTTPS (works behind proxies if trust proxy is set)
  return Boolean(req.secure);
}

function buildInternalLoginNext(returnTo) {
  const url = new URL("https://app.invalid/sso/hcs-sync");
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return url.pathname + url.search;
}

function parseReturnTo(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u;
  } catch {
    return null;
  }
}

function isAllowedReturnTo(urlObj) {
  const allowList = String(
    process.env.HCS_SSO_RETURN_HOSTS || "sync.heroncs.co.uk",
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const host = String(urlObj.hostname || "").toLowerCase();
  if (!allowList.includes(host)) return false;

  const protocol = String(urlObj.protocol || "").toLowerCase();
  const allowHttp =
    String(process.env.HCS_SSO_ALLOW_HTTP || "").toLowerCase() === "true";
  if (protocol === "https:") return true;
  if (isLocalhostHostname(host) && protocol === "http:") return true;
  if (allowHttp && protocol === "http:") return true;
  return false;
}

function upgradeReturnToToHttpsIfAllowed(urlObj) {
  if (!urlObj) return null;

  // If the target host is allowlisted but proto is http (common when upstream
  // loses X-Forwarded-Proto), upgrade to https rather than rejecting.
  try {
    const hostAllowList = String(
      process.env.HCS_SSO_RETURN_HOSTS || "sync.heroncs.co.uk",
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const host = String(urlObj.hostname || "").toLowerCase();
    const proto = String(urlObj.protocol || "").toLowerCase();

    // Local development: if return host is localhost/loopback, prefer plain HTTP.
    if (isLocalhostHostname(host)) {
      urlObj.protocol = "http:";
      return urlObj;
    }

    const allowHttp =
      String(process.env.HCS_SSO_ALLOW_HTTP || "").toLowerCase() === "true";
    if (proto === "http:" && !allowHttp && hostAllowList.includes(host)) {
      urlObj.protocol = "https:";
    }
  } catch {
    // ignore
  }

  return urlObj;
}

exports.hcsSyncHandoff = async (req, res) => {
  const returnTo = upgradeReturnToToHttpsIfAllowed(
    parseReturnTo(req.query?.return_to),
  );

  // Not authenticated → bounce to login (internal next only).
  if (!req.user) {
    const internalNext = buildInternalLoginNext(
      returnTo ? returnTo.toString() : "",
    );
    return res.redirect("/user/login?next=" + encodeURIComponent(internalNext));
  }

  // Validate return_to to prevent open redirects.
  if (!returnTo || !isAllowedReturnTo(returnTo)) {
    return res.status(400).send("Invalid return URL");
  }

  // Role gate: only back-office roles may access the sync dashboard.
  if (!isRoleAllowedForSync(req.user.role)) {
    logger.warn(
      `[sso] handoff denied: role "${req.user.role}" not permitted for hcs-sync (user=${req.user.username})`,
    );
    return res
      .status(403)
      .send("Your account does not have access to the sync dashboard.");
  }

  const secret = process.env.HCS_SSO_JWT_SECRET;
  if (!secret) {
    logger.error(
      "[sso] HCS_SSO_JWT_SECRET missing – cannot sign SSO token",
    );
    return res.status(500).send("SSO not configured");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Number(process.env.HCS_SSO_TTL_SECONDS || 60 * 60 * 8);

  const token = jwt.sign(
    {
      sub: req.user._id.toString(),
      username: req.user.username,
      role: req.user.role,
      iss: "hcs-app",
      aud: "hcs-sync",
      iat: nowSec,
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: ttlSec,
      jwtid: crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex"),
    },
  );

  const cookieDomain = String(
    process.env.HCS_SSO_COOKIE_DOMAIN ||
      process.env.SESSION_COOKIE_DOMAIN ||
      "",
  ).trim();

  // Derive a shared parent domain when no explicit cookie domain is configured.
  // e.g. app.heroncs.co.uk + sync.heroncs.co.uk → .heroncs.co.uk
  let effectiveDomain = cookieDomain;
  if (!effectiveDomain) {
    try {
      const appHost = (req.hostname || req.headers?.host || "")
        .split(":")[0]
        .toLowerCase();
      const targetHost = String(returnTo.hostname || "").toLowerCase();
      if (appHost && targetHost && appHost !== targetHost) {
        const appParts = appHost.split(".");
        const targetParts = targetHost.split(".");
        const common = [];
        while (
          appParts.length &&
          targetParts.length &&
          appParts[appParts.length - 1] === targetParts[targetParts.length - 1]
        ) {
          common.unshift(appParts.pop());
          targetParts.pop();
        }
        // Need at least a registrable domain (e.g. heroncs.co.uk → 3 labels)
        if (common.length >= 2) {
          effectiveDomain = "." + common.join(".");
          logger.info(
            `[sso] No explicit cookie domain; derived "${effectiveDomain}" from ${appHost} ↔ ${targetHost}`,
          );
        }
      }
    } catch (_) {
      /* ignore derivation errors */
    }
  }

  res.cookie("hcs_sso", token, {
    httpOnly: true,
    secure: getCookieSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: ttlSec * 1000,
    ...(effectiveDomain ? { domain: effectiveDomain } : {}),
  });

  return res.redirect(returnTo.toString());
};

/**
 * POST /api/sso/token
 * Machine-to-machine endpoint used by hcs-sync's login form.
 * Validates username+password and issues a short-lived JWT without creating
 * an hcs-app session, so the user never leaves hcs-sync.
 *
 * Requires header:  X-Sync-Api-Key: <HCS_SYNC_API_KEY>
 * Body (JSON):      { username, password }
 * Response (JSON):  { token, expiresIn }
 */
exports.issueTokenForSync = async (req, res) => {
  const apiKey = String(process.env.HCS_SYNC_API_KEY || "").trim();
  if (!apiKey) {
    logger.error("[sso] HCS_SYNC_API_KEY not configured – /api/sso/token is disabled");
    return res.status(503).json({ error: "Token endpoint not configured" });
  }

  const provided = String(req.headers["x-sync-api-key"] || "");
  if (!provided || !safeEqual(apiKey, provided)) {
    logger.warn("[sso] /api/sso/token: invalid API key");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  let user;
  try {
    user = await mdb.INTERNAL.user.findOne({
      $or: [{ username }, { email: username }],
    });
  } catch (err) {
    logger.error("[sso] /api/sso/token: DB error: %s", err.message);
    return res.status(503).json({ error: "Service unavailable" });
  }

  // Enforce the same account lockout as the browser login flow.
  const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 5;
  const LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS) || 15 * 60 * 1000;

  if (user && user.lockedUntil && user.lockedUntil > new Date()) {
    const remaining = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    logger.warn(
      `[sso] /api/sso/token: account locked user=${user.username} remaining=${remaining}min`,
    );
    return res.status(401).json({
      error: `Account temporarily locked. Try again in ${remaining} minute${remaining !== 1 ? "s" : ""}.`,
      code: "locked",
    });
  }

  const recordFailedAttempt = async () => {
    if (!user) return;
    try {
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      if (user.loginAttempts >= MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.loginAttempts = 0;
        logger.warn(
          `[sso] /api/sso/token: account locked after ${MAX_ATTEMPTS} failures user=${user.username}`,
        );
      }
      await user.save();
    } catch (saveErr) {
      logger.error("[sso] failed to record login attempt: %s", saveErr.message);
    }
  };

  let authOk = false;
  if (user) {
    const stored = user.password;
    const looksHashed = typeof stored === "string" && stored.startsWith("$2");
    if (looksHashed) {
      authOk = await bcrypt.compare(password, stored);
    } else if (safeEqual(password, stored)) {
      authOk = true;
      try {
        user.password = await bcrypt.hash(stored, 12);
        await user.save();
        logger.info("[sso] plaintext→bcrypt password upgraded for \"%s\"", user.username);
      } catch (upgradeErr) {
        logger.warn("[sso] plaintext→bcrypt upgrade failed for \"%s\": %s", user.username, upgradeErr.message);
      }
    }
  }

  if (!authOk) {
    logger.info("[sso] /api/sso/token: invalid credentials for \"%s\"", username);
    await recordFailedAttempt();
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Role gate: only back-office roles may access the sync dashboard.
  if (!isRoleAllowedForSync(user.role)) {
    logger.warn(
      `[sso] /api/sso/token: role "${user.role}" not permitted for hcs-sync (user=${user.username})`,
    );
    require("../../services/auditLogService").record("sso_token_denied", req, {
      userId: user._id, username: user.username, meta: { role: user.role, reason: "role_denied" },
    });
    return res.status(403).json({
      error: "Your account does not have access to the sync dashboard.",
      code: "role_denied",
    });
  }

  // 2FA: users with TOTP enabled must supply a valid code — the sync login
  // must not be a way to sidestep two-factor authentication.
  if (user.totpEnabled && user.totpSecret) {
    const totpCode = String(req.body?.totp || "").trim();
    if (!totpCode) {
      return res.status(401).json({
        error: "Two-factor authentication code required.",
        code: "totp_required",
      });
    }
    let totpOk = false;
    try {
      const decryptedSecret = encryptionService.decrypt(user.totpSecret);
      totpOk = totpService.verifyTOTP(decryptedSecret, totpCode);
    } catch (totpErr) {
      logger.error("[sso] TOTP verification error for \"%s\": %s", user.username, totpErr.message);
    }
    if (!totpOk) {
      logger.info("[sso] /api/sso/token: invalid TOTP for \"%s\"", user.username);
      await recordFailedAttempt();
      return res.status(401).json({
        error: "Invalid two-factor authentication code.",
        code: "totp_invalid",
      });
    }
  }

  // Reset lockout state on successful auth.
  if (user.loginAttempts || user.lockedUntil) {
    try {
      user.loginAttempts = 0;
      user.lockedUntil = null;
      await user.save();
    } catch (resetErr) {
      logger.warn("[sso] failed to reset lockout state: %s", resetErr.message);
    }
  }

  const secret = process.env.HCS_SSO_JWT_SECRET;
  if (!secret) {
    logger.error("[sso] HCS_SSO_JWT_SECRET missing – cannot issue token");
    return res.status(500).json({ error: "SSO not configured" });
  }

  const ttlSec = Number(process.env.HCS_SSO_TTL_SECONDS || 60 * 60 * 8);
  const nowSec = Math.floor(Date.now() / 1000);

  const token = jwt.sign(
    {
      sub: user._id.toString(),
      username: user.username,
      role: user.role,
      iss: "hcs-app",
      aud: "hcs-sync",
      iat: nowSec,
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: ttlSec,
      jwtid: crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex"),
    },
  );

  logger.info("[sso] /api/sso/token: issued token for user \"%s\"", user.username);
  require("../../services/auditLogService").record("sso_token_issued", req, {
    userId: user._id, username: user.username, meta: { ttlSec },
  });
  return res.json({ token, expiresIn: ttlSec });
};
