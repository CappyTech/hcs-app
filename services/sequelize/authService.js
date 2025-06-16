const logger = require('../loggerService');
const db = require('./sequelizeDatabaseService');

/**
 * Middleware to ensure the user is authenticated.
 * Logs authentication details for every request.
 * Validates all key properties inside `session.user` (id, email, role, username).
 * Redirects to the sign-in page if any required property is missing or invalid.
 * 
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @param {Function} next - The next middleware function.
 */
const ensureAuthenticated = async (req, res, next) => {
    try {
        // Destructure session.user
        const { id, username, email, role } = req.session.user || {};

        // Log request details regardless of the outcome
        logger.info(`
            Authentication Check:
            User ID: ${id || 'N/A'}
            Username: ${username || 'N/A'}
            Email: ${email || 'N/A'}
            Role: ${role || 'N/A'}
            Request Path: ${req.method} ${req.originalUrl}
        `);

        // Validate all required properties
        if (!id || !username || !email || !role) {
            req.flash('error', 'Invalid session. Please sign in.');
            logger.info(`Access denied: Missing required session properties for ${req.method} ${req.originalUrl}`);
            return res.redirect('/user/signin');
        }

        // Optional: Verify against the database
        const dbUser = await db.Users.findOne({
            where: { id, username, email, role }
        });

        if (!dbUser) {
            req.flash('error', 'Session data mismatch. Please sign in again.');
            logger.info(`Access denied: Session mismatch for user ID ${id || 'N/A'} on ${req.method} ${req.originalUrl}`);
            return res.redirect('/user/signin');
        }

        // User is authenticated, proceed
        logger.info(`Authentication successful: User ID ${id}, Username ${username}, Role ${role}`);

        req.session.regenerate((err) => {
            if (err) {
                logger.error('Session regeneration failed:', err);
                return res.redirect('/user/signin');
            }
            req.session.user = dbUser; // Reassign the user object after regeneration
            next();
        });

        next();
    } catch (error) {
        logger.error(`Authentication error: ${error.message}`);
        req.flash('error', 'An error occurred during authentication. Please try again.');
        res.redirect('/user/signin');
    }
};


/**
 * Middleware to ensure the user has one of the specified roles.
 * Logs user details and role validation for every request, regardless of access outcome.
 * Redirects to the home page if the user does not have the correct role.
 * 
 * @param {Array<string>} roles - The allowed roles for the route.
 * @returns {Function} - The middleware function.
 */
const ensureRole = (roles) => {
    return (req, res, next) => {
        try {
            const { id, username, role } = req.session.user || {};

            const dbUser = db.Users.findOne({
                where: { id }
            });

            if (dbUser) {
                // Log the request details regardless of access outcome
                logger.info(`
                    Role Validation:
                    User ID: ${id || 'N/A'}
                    Username: ${username || 'N/A'}
                    Role: ${role || 'N/A'}
                    Allowed Roles: ${JSON.stringify(roles)}
                    Request Path: ${req.method} ${req.originalUrl}
                `);
                next();
            }

            // Check if role exists and is valid
            if (!role || !roles.includes(role)) {
                req.flash('error', 'Access denied. You do not have the correct role.');
                logger.info(`Access denied: User ID ${id || 'N/A'}, Role: ${role || 'N/A'}, Path: ${req.method} ${req.originalUrl}`);
                
                // Properly handle the error
                const err = new Error("Access Denied");
                err.statusCode = 403;
                return next(err);
            }

            // Role is valid, proceed
            next();
        } catch (error) {
            logger.error(`Role validation error: ${error.message}`);
            req.flash('error', 'An error occurred while checking your role. Please try again.');
            next(error); // Pass the error to the error handler
        }
    };
};



/**
 * Middleware to ensure the user has the required permissions.
 * Logs user details and permissions for every request, regardless of the outcome.
 * Checks if the user is signed in and has the necessary permissions.
 * If not, redirects to the home page.
 * 
 * @param {Array<string>} requiredPermissions - The permissions required to access the route.
 * @returns {Function} - The middleware function.
 */
const ensurePermission = (requiredPermissions) => {
    return (req, res, next) => {
        // Extract user and permissions from session
        const user = req.session.user;

        const dbUser = db.Users.findOne({
            where: { id }
        });

        if (dbUser) {
            // Log details of the current request
            logger.info(`
                Permission Check:
                User ID: ${user?.id || 'N/A'}
                Username: ${user?.username || 'N/A'}
                Role: ${user?.role || 'N/A'}
                Current Permissions: ${JSON.stringify(user || {})}
                Required Permissions: ${JSON.stringify(requiredPermissions)}
                Request Path: ${req.method} ${req.originalUrl}
            `);
            next();
        }

        // Check if the user is signed in
        if (!user) {
            req.flash('error', 'Please sign in.');
            logger.info(`Access denied: User not signed in for ${req.method} ${req.originalUrl}`);
            return res.redirect('/user/signin');
        }

        // Ensure required permissions exist in the user object
        const hasPermission = requiredPermissions.every(permission => user[permission] === true);

        // Deny access if permissions are insufficient
        if (!hasPermission) {
            req.flash('error', 'Access denied. You do not have the correct permissions.');
            logger.info(`Access denied: Insufficient permissions for user ID ${user.id}`);
            
            // Properly handle the error
            const err = new Error("Insufficient Permissions");
            err.statusCode = 403;
            return next(err);
        }

        // If permissions are valid, proceed to the next middleware
        next();
    };
};


module.exports = {
    ensureAuthenticated,
    ensureRole,
    ensurePermission,
};