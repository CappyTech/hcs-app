const mdb = require('../mongoose/services/mongooseDatabaseService');

// Populate req.user from session if available (non-blocking)
async function ensureAuthenticated(req, res, next) {
  if (!req.session || !req.session.user) return next();

  try {
  const user = await mdb.INTERNAL.user.findById(req.session.user.id);
    if (user) {
      req.user = user;
    } else {
      delete req.session.user;
    }
  } catch (err) {
    return next({
      statusCode: 500,
      name: 'DatabaseError',
      message: 'Failed to fetch user from database',
      stack: err.stack,
    });
  }

  next();
}

// Blocks unless user has required role(s)
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

// Default role-based middleware
function ensureRole(role = 'admin') {
  if (role === 'none') return (req, res, next) => next();
  return ensureRoles(role);
}

module.exports = {
  ensureAuthenticated,
  ensureRoles,
  ensureRole,
};
