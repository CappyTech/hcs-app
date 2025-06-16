const logger = require('../loggerService');
const mdb = require('./mongooseDatabaseService');

/**
 * Ensure the user is authenticated.
 */
const ensureAuthenticated = async (req, res, next) => {
  try {
    const { id, username, email, role } = req.session.user || {};

    if (!id || !username || !email || !role) {
      req.flash('error', 'Invalid session. Please sign in.');
      logger.info(`Access denied: Missing session properties for ${req.method} ${req.originalUrl}`);
      return res.redirect('/user/signin');
    }

    const dbUser = await mdb.user.findOne({ _id: id, username, email, role });

    if (!dbUser) {
      req.flash('error', 'Session data mismatch. Please sign in again.');
      logger.info(`Access denied: Session mismatch for user ID ${id}`);
      return res.redirect('/user/signin');
    }

    next();
  } catch (error) {
    logger.error(`Authentication error: ${error.message}`);
    req.flash('error', 'An error occurred during authentication. Please try again.');
    res.redirect('/user/signin');
  }
};

/**
 * Ensure the user has one of the allowed roles.
 */
const ensureRole = (roles) => {
  return (req, res, next) => {
    try {
      const { id, username, role } = req.session.user || {};

      if (!role || !roles.includes(role)) {
        req.flash('error', 'Access denied. You do not have the correct role.');
        logger.info(`Access denied: Role ${role} not allowed for path ${req.method} ${req.originalUrl}`);
        return res.redirect('/');
      }

      next();
    } catch (error) {
      logger.error(`Role validation error: ${error.message}`);
      req.flash('error', 'An error occurred while checking your role. Please try again.');
      next(error);
    }
  };
};

/**
 * Ensure the user has all required permissions.
 */
const ensurePermission = (requiredPermissions) => {
  return (req, res, next) => {
    const user = req.session.user;

    if (!user) {
      req.flash('error', 'Please sign in.');
      logger.info(`Access denied: User not signed in for ${req.method} ${req.originalUrl}`);
      return res.redirect('/user/signin');
    }

    const hasPermission = requiredPermissions.every(p => user?.permissions?.[p] === true);

    if (!hasPermission) {
      req.flash('error', 'Access denied. You do not have the correct permissions.');
      logger.info(`Access denied: User ${user.username} lacks permissions: ${JSON.stringify(requiredPermissions)}`);
      return res.redirect('/');
    }

    next();
  };
};

module.exports = {
  ensureAuthenticated,
  ensureRole,
  ensurePermission,
};
