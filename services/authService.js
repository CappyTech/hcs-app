import mdb from '../mongoose/services/mongooseDatabaseService.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';

// ── Paths that never require authentication ──────────────────────────
const PUBLIC_PATHS = new Set([
  "/user/login",
  "/user/register",
  "/user/verify-email",
  "/user/forgot-password",
  "/user/forgot-password/choose",
  "/user/reset-password",
  "/user/verify-sms-otp",
  "/user/verify-totp-reset",
  "/user/2fa",
  "/health",
  // Token-scoped unsubscribe. Has no browser session — it is authorised solely
  // by the per-recipient notificationToken and only ever changes that one
  // recipient's notification preferences (never a login). GET is read-only.
  "/notifications/unsubscribe",
  // Machine-to-machine SSO token issuance for hcs-sync. Has no browser session;
  // it authenticates itself via the X-Sync-Api-Key header + credential check,
  // so it must bypass the session-based ensureAuthenticated guard.
  "/api/sso/token",
]);
const PUBLIC_PREFIXES = ["/resources/", "/manifest/", "/legal/"];

// Paths accessible to authenticated-but-unverified users
const UNVERIFIED_PATHS = new Set([
  "/user/verify-pending",
  "/user/resend-verification",
  "/user/logout",
  "/user/profile",
  "/user/account",
]);

// ── Per-role 2FA enforcement ──────────────────────────────────────────
// Roles listed here must have TOTP enabled; until then they are restricted
// to the account page (where 2FA is set up) and the paths below.
// Override with REQUIRE_2FA_ROLES (comma-separated; empty string disables).
function rolesRequiring2FA() {
  const raw = process.env.REQUIRE_2FA_ROLES;
  const value = raw === undefined ? "admin,accountant" : raw;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

const TWOFA_SETUP_PATHS = new Set([
  "/user/logout",
  "/user/profile",
  "/user/verify-pending",
  "/user/resend-verification",
]);

function isTwoFASetupPath(path) {
  return TWOFA_SETUP_PATHS.has(path) || path.startsWith("/user/account");
}

function isPublicPath(url) {
  const path = url.split("?")[0];
  if (path === "/") return true;
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

// ── Populate req.user from session — blocks unauthenticated users ────
async function ensureAuthenticated(req, res, next) {
  // Always allow public paths through without a user
  if (isPublicPath(req.originalUrl)) {
    if (req.session?.user) {
      try {
        const user = await mdb.INTERNAL.user.findById(req.session.user.id);
        if (user) req.user = user;
        else delete req.session.user;
      } catch (_) {
        /* swallow — public page still works */
      }
    }
    return next();
  }

  // Authenticated paths: must have a session
  if (!req.session || !req.session.user) {
    // Store the original URL for post-login redirect
    const returnTo = req.originalUrl;
    return res.redirect("/user/login?next=" + encodeURIComponent(returnTo));
  }

  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (user) {
      req.user = user;
    } else {
      delete req.session.user;
      return res.redirect("/user/login");
    }
  } catch (err) {
    return next({
      statusCode: 500,
      name: "DatabaseError",
      message: "Failed to fetch user from database",
      stack: err.stack,
    });
  }

  // Block unverified users — only allow access to verification-related pages
  // Treat legacy users (field missing in DB → undefined before Mongoose default) as verified.
  // Only block users who explicitly have emailVerified === false AND have a verification token.
  const reqPath = req.originalUrl.split("?")[0];
  if (
    req.user.emailVerified === false &&
    req.user.emailVerificationToken != null &&
    !UNVERIFIED_PATHS.has(reqPath)
  ) {
    return res.redirect("/user/verify-pending");
  }

  // Per-role 2FA enforcement: privileged roles must enable TOTP before
  // accessing anything beyond their account page.
  if (
    !req.user.totpEnabled &&
    rolesRequiring2FA().includes(req.user.role) &&
    !isTwoFASetupPath(reqPath)
  ) {
    if (typeof req.flash === "function") {
      req.flash(
        "error",
        `Your role (${req.user.role}) requires two-factor authentication. Please enable it to continue.`,
      );
    }
    return res.redirect("/user/account");
  }

  next();
}

// ── Block unless user has one of the required role(s) ────────────────
function ensureRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: "UnauthorizedError",
        message: "User not authenticated",
      });
    }

    // 1. Role match — allow
    if (roles.includes(req.user.role)) return next();

    // 2. Custom route permission — check if this path is in user's custom grants
    const customRoutes = req.user.customPermissions?.routes || [];
    if (customRoutes.length > 0) {
      const matched = rbac.matchRoutePattern(req.path);
      if (matched && customRoutes.includes(matched)) return next();
    }

    return next({
      statusCode: 403,
      name: "ForbiddenError",
      message: "You do not have permission to access this page.",
    });
  };
}

// ── Shortcut — defaults to 'admin'. 'public' = passthrough. ────────
function ensureRole(role = "admin") {
  if (role === "public") return (req, res, next) => next();
  return ensureRoles(role);
}

// ── Allow any authenticated user (any role) ──────────────────────────
function ensureAnyRole() {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: "UnauthorizedError",
        message: "User not authenticated",
      });
    }
    next();
  };
}

// ── RBAC-aware middleware: check role + model + operation ─────────────
// Usage: ensureModelAccess('invoice', 'r')
function ensureModelAccess(model, operation) {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: "UnauthorizedError",
        message: "User not authenticated",
      });
    }
    const customPerms = req.user.customPermissions || {};
    const { allowed, ownOnly } = rbac.canAccess(
      req.user.role,
      model,
      operation,
      customPerms,
    );
    if (!allowed) {
      return next({
        statusCode: 403,
        name: "ForbiddenError",
        message: `Role "${req.user.role}" cannot ${operation} on ${model}`,
      });
    }
    // Stash for downstream controllers to enforce ownership
    req.rbac = { ownOnly, model, operation };
    next();
  };
}

// ── Ownership check middleware ────────────────────────────────────────
// Attaches a Mongoose query filter to req.ownershipFilter for use in
// controllers.  Admin always gets an empty filter (sees everything).
function ensureOwnership(model) {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: "UnauthorizedError",
        message: "User not authenticated",
      });
    }

    // Admin bypasses ownership
    if (req.user.role === "admin") {
      req.ownershipFilter = {};
      return next();
    }

    // Check if RBAC says this is own-only
    const ownOnly = req.rbac?.ownOnly ?? true;
    if (!ownOnly) {
      req.ownershipFilter = {};
      return next();
    }

    const ownerCfg = rbac.getOwnershipConfig(req.user.role, model);
    if (!ownerCfg) {
      return next({
        statusCode: 403,
        name: "ForbiddenError",
        message: `No ownership mapping for role "${req.user.role}" on model "${model}"`,
      });
    }

    const userEntityId = req.user[ownerCfg.userField];
    if (!userEntityId) {
      return next({
        statusCode: 403,
        name: "ForbiddenError",
        message: `User has no linked ${ownerCfg.userField}`,
      });
    }

    req.ownershipFilter = { [ownerCfg.modelField]: userEntityId };
    next();
  };
}

// ── Global route-access guard (uses routeAccess config + customPerms) ─
function ensureRouteAccess(req, res, next) {
  // Only applies to authenticated users (ensureAuthenticated runs first)
  if (!req.user) return next();

  const matched = rbac.matchRoutePattern(req.path);
  // No pattern in config → not a controlled route, let per-route guards decide
  if (!matched) return next();

  const customPerms = req.user.customPermissions || {};
  if (rbac.canAccessRoute(req.user.role, matched, customPerms)) return next();

  return next({
    statusCode: 403,
    name: "ForbiddenError",
    message: "You do not have permission to access this page.",
  });
}

// ── Department access middleware ──────────────────────────────────────
function ensureDepartment(department) {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: "UnauthorizedError",
        message: "User not authenticated",
      });
    }
    const customPerms = req.user.customPermissions || {};
    if (!rbac.canAccessDepartment(req.user.role, department, customPerms)) {
      return next({
        statusCode: 403,
        name: "ForbiddenError",
        message: `Role "${req.user.role}" cannot access department "${department}"`,
      });
    }
    next();
  };
}

export default {
  ensureAuthenticated,
  ensureRouteAccess,
  rolesRequiring2FA,
  ensureRoles,
  ensureRole,
  ensureAnyRole,
  ensureModelAccess,
  ensureOwnership,
  ensureDepartment,
};

export { ensureAuthenticated, ensureRouteAccess, rolesRequiring2FA, ensureRoles, ensureRole, ensureAnyRole, ensureModelAccess, ensureOwnership, ensureDepartment };
