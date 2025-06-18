const jwt = require('jsonwebtoken');
const mdb = require('./mongoose/mongooseDatabaseService');

// Checks token and populates req.user (non-blocking)
async function ensureAuthenticated(req, res, next) {
  const token = req.cookies.token;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await mdb.user.findById(decoded.id);
    if (user) {
      req.user = user;
    } else {
      res.clearCookie('token');
    }
  } catch (err) {
    res.clearCookie('token');
  }

  next();
}

// Blocks if user is not authenticated
function requireLogin(req, res, next) {
  if (!req.user) {
    return res.redirect('/signin'); // or res.status(401).send('Unauthorized');
  }
  next();
}

// Blocks if user is authenticated (e.g. signin/register pages)
function doesntRequireLogin(req, res, next) {
  if (req.user) {
    return res.redirect('/dashboard'); // or wherever you want to redirect logged-in users
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
