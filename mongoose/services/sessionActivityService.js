const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');

// Middleware: update lastActivity for current session (throttled)
module.exports.touchSessionActivity = async function touchSessionActivity(req, res, next) {
  if (!req.sessionID || !req.session?.user) return next();
  try {
    const now = new Date();
    // Only update if >60s since last update to reduce writes
    if (!req.session._lastActivityTouch || (now - req.session._lastActivityTouch) > 60000) {
      req.session._lastActivityTouch = now;
      mdb.session.updateOne({ _id: req.sessionID }, { $set: { lastActivity: now } }).catch(()=>{});
    }
  } catch (e) {
    logger.warn('Session activity touch failed: ' + e.message);
  } finally {
    next();
  }
};
