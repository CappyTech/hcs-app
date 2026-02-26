const mdb = require('../mongoose/services/mongooseDatabaseService');
const rbac = require('../mongoose/config/rolePermissionsConfig');

// ── Paths that never require authentication ──────────────────────────
const PUBLIC_PATHS = new Set([
  '/user/login',
  '/user/register',
  '/user/verify-email',
  '/health',
]);
const PUBLIC_PREFIXES = ['/resources/', '/manifest/'];

// Paths accessible to authenticated-but-unverified users
const UNVERIFIED_PATHS = new Set([
  '/user/verify-pending',
  '/user/resend-verification',
  '/user/logout',
  '/user/profile',
  '/user/account',
]);

function isPublicPath(url) {
  const path = url.split('?')[0];
  if (path === '/') return true;
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some(p => path.startsWith(p));
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
      } catch (_) { /* swallow — public page still works */ }
    }
    return next();
  }

  // Authenticated paths: must have a session
  if (!req.session || !req.session.user) {
    // Store the original URL for post-login redirect
    const returnTo = req.originalUrl;
    return res.redirect('/user/login?next=' + encodeURIComponent(returnTo));
  }

  try {
    const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (user) {
      req.user = user;
    } else {
      delete req.session.user;
      return res.redirect('/user/login');
    }
  } catch (err) {
    return next({
      statusCode: 500,
      name: 'DatabaseError',
      message: 'Failed to fetch user from database',
      stack: err.stack,
    });
  }

  // Block unverified users — only allow access to verification-related pages
  // Treat legacy users (field missing in DB → undefined before Mongoose default) as verified.
  // Only block users who explicitly have emailVerified === false AND have a verification token.
  const reqPath = req.originalUrl.split('?')[0];
  if (req.user.emailVerified === false
      && req.user.emailVerificationToken != null
      && !UNVERIFIED_PATHS.has(reqPath)) {
    return res.redirect('/user/verify-pending');
  }

  next();
}

// ── Block unless user has one of the required role(s) ────────────────
function ensureRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: 'UnauthorizedError',
        message: 'User not authenticated',
      });
    }

    if (!roles.includes(req.user.role)) {
      return next({
        statusCode: 403,
        name: 'ForbiddenError',
        message: `User role "${req.user.role}" is not in [${roles.join(', ')}]`,
      });
    }

    next();
  };
}

// ── Shortcut — defaults to 'admin'. 'public' = passthrough. ────────
function ensureRole(role = 'admin') {
  if (role === 'public') return (req, res, next) => next();
  return ensureRoles(role);
}

// ── Allow any authenticated user (any role) ──────────────────────────
function ensureAnyRole() {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401,
        name: 'UnauthorizedError',
        message: 'User not authenticated',
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
        statusCode: 401, name: 'UnauthorizedError',
        message: 'User not authenticated',
      });
    }
    const { allowed, ownOnly } = rbac.canAccess(req.user.role, model, operation);
    if (!allowed) {
      return next({
        statusCode: 403, name: 'ForbiddenError',
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
        statusCode: 401, name: 'UnauthorizedError',
        message: 'User not authenticated',
      });
    }

    // Admin bypasses ownership
    if (req.user.role === 'admin') {
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
        statusCode: 403, name: 'ForbiddenError',
        message: `No ownership mapping for role "${req.user.role}" on model "${model}"`,
      });
    }

    const userEntityId = req.user[ownerCfg.userField];
    if (!userEntityId) {
      return next({
        statusCode: 403, name: 'ForbiddenError',
        message: `User has no linked ${ownerCfg.userField}`,
      });
    }

    req.ownershipFilter = { [ownerCfg.modelField]: userEntityId };
    next();
  };
}

// ── Department access middleware ──────────────────────────────────────
function ensureDepartment(department) {
  return (req, res, next) => {
    if (!req.user) {
      return next({
        statusCode: 401, name: 'UnauthorizedError',
        message: 'User not authenticated',
      });
    }
    if (!rbac.canAccessDepartment(req.user.role, department)) {
      return next({
        statusCode: 403, name: 'ForbiddenError',
        message: `Role "${req.user.role}" cannot access department "${department}"`,
      });
    }
    next();
  };
}

module.exports = {
  ensureAuthenticated,
  ensureRoles,
  ensureRole,
  ensureAnyRole,
  ensureModelAccess,
  ensureOwnership,
  ensureDepartment,
};
