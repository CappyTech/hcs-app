const mdb = require('./mongoose/mongooseDatabaseService');

// Populate req.user from session if available (non-blocking)
async function ensureAuthenticated(req, res, next) {
  if (!req.session || !req.session.user) return next();

  try {
    const user = await mdb.user.findById(req.session.user.id);
    if (user) {
      req.user = user;
    } else {
      delete req.session.user;
    }
  } catch (err) {
    delete req.session.user;
  }

  next();
}

// Blocks if user is not authenticated
function requireLogin(req, res, next) {
  if (!req.user) {
    return res.redirect('/user/login');
  }
  next();
}

// Blocks if user is authenticated (e.g. signin/register pages)
function doesntRequireLogin(req, res, next) {
  if (req.user) {
    return res.redirect('/');
  }
  next();
}

// Blocks unless user has required role(s)
function ensureRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    if (!roles.includes(req.user.role)) {
      return res.status(403).send(`Forbidden: Requires one of [${roles.join(', ')}]`);
    }
    next();
  };
}

module.exports = {
  ensureAuthenticated,
  requireLogin,
  doesntRequireLogin,
  ensureRoles,
};
