const jwt = require('jsonwebtoken');
const mdb = require('./mongoose/mongooseDatabaseService');

module.exports = async function (req, res, next) {
  const token = req.cookies.token;

  if (!token) return next(); // Not authenticated, but no error

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await mdb.user.findById(decoded.id);
    if (!user) return next();
    req.user = user;
  } catch (err) {
    // Optional: log or clear invalid cookie
    res.clearCookie('token');
  }

  next();
};