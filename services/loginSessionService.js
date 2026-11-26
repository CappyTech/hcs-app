/**
 * loginSessionService — turn a verified person into a signed-in session.
 *
 * Used once every sign-in step has passed (2FA code, passkey). Regenerates
 * the session id (session-fixation defence), writes req.session.user, saves,
 * and denormalises the user onto the session document so the active-sessions
 * list can query it.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import logger from './loggerService.js';
import { getClientIp } from './ipService.js';

function promisify(fn) {
  return new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));
}

export async function completeLogin(req, user, { tag = 'login' } = {}) {
  const agent = req.useragent || {};
  const ip = getClientIp(req);

  await promisify((cb) => req.session.regenerate(cb));

  req.session.user = {
    id: user._id.toString(),
    uuid: user.uuid,
    username: user.username,
    email: user.email,
    role: user.role,
    loginTime: new Date().toISOString(),
    ip,
    userAgent: {
      browser: agent.browser || 'Unknown',
      version: agent.version || 'Unknown',
      os: agent.os || 'Unknown',
      platform: agent.platform || 'Unknown',
    },
  };

  await promisify((cb) => req.session.save(cb));

  if (mdb.INTERNAL?.session) {
    mdb.INTERNAL.session
      .updateOne(
        { _id: req.sessionID },
        {
          $set: {
            userId: user._id.toString(),
            username: user.username,
            email: user.email,
            role: user.role,
            ip,
            uaBrowser: req.session.user.userAgent.browser,
            uaVersion: req.session.user.userAgent.version,
            uaOS: req.session.user.userAgent.os,
            loginTime: new Date(req.session.user.loginTime),
          },
        },
        { upsert: true },
      )
      .catch((err) => logger.warn(`[SESSION DENORM ${tag}] failed: ${err.message}`));
  }
  return req.session.user;
}

export default { completeLogin };
