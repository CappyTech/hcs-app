// services/authSessionService.js
//
// Shared session establishment for every login path (password, and Microsoft
// SSO). Kept identical to the password flow in userCRUDController.loginUser so a
// session created by SSO is indistinguishable from a normal one: same shape,
// same fixation protection (regenerate), same denormalised session document.

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import logger from './loggerService.js';

/**
 * Build the canonical session.user payload for a logged-in user.
 * @param {object} user  Mongoose user document
 * @param {{ip?:string, agent?:object, next?:string|null}} ctx
 */
function buildSessionData(user, { ip = '', agent = {}, next = null } = {}) {
  return {
    id: user._id.toString(),
    uuid: user.uuid,
    username: user.username,
    email: user.email,
    role: user.role,
    loginTime: new Date().toISOString(),
    ip,
    next,
    userAgent: {
      browser: agent.browser || 'Unknown',
      version: agent.version || 'Unknown',
      os: agent.os || 'Unknown',
      platform: agent.platform || 'Unknown',
    },
  };
}

/**
 * Regenerate the session (fixation protection), attach the user payload, persist
 * it, and denormalise the identifying fields onto the session document for the
 * admin session list. Mirrors userCRUDController.loginUser exactly.
 */
async function establishSession(req, user, sessionData) {
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });

  req.session.user = sessionData;

  await new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });

  try {
    if (mdb.INTERNAL.session) {
      await mdb.INTERNAL.session.updateOne(
        { _id: req.sessionID },
        {
          $set: {
            userId: user._id.toString(),
            username: user.username,
            email: user.email,
            role: user.role,
            ip: sessionData.ip,
            uaBrowser: sessionData.userAgent.browser,
            uaVersion: sessionData.userAgent.version,
            uaOS: sessionData.userAgent.os,
            loginTime: new Date(sessionData.loginTime),
          },
        },
        { upsert: true },
      );
    }
  } catch (e) {
    logger.warn(`Session denorm (establishSession) failed: ${e.message}`);
  }
}

export default { buildSessionData, establishSession };
