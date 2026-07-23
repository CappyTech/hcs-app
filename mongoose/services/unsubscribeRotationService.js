/**
 * unsubscribeRotationService — periodically rotates every user's
 * notificationToken so unsubscribe links expire ~daily.
 *
 * Because the notificationToken is mixed into the HMAC key of every signed
 * unsubscribe link (unsubscribeTokenService), rotating it invalidates that
 * user's outstanding links. Running this for all users every 24h (and on
 * startup) bounds an unsubscribe link's usable life to ~24h.
 *
 * Persistence: last run is stored via jobStateService so the job does NOT
 * re-fire on every restart/deploy (which would cut links shorter than 24h).
 * Enable/disable is an admin toggle read from configService
 * (UNSUBSCRIBE_ROTATION_ENABLED, default on).
 */

import crypto from 'crypto';
import mdb from './mongooseDatabaseService.js';
import jobStateService from './jobStateService.js';
import configService from '../../services/configService.js';
import logger from '../../services/loggerService.js';

const JOB_NAME = 'unsubscribe-token-rotation';
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
// Treat a rotation as still "fresh" until it is nearly a day old, so a restart
// shortly after a rotation does not rotate again.
const DUE_AFTER_MS = INTERVAL_MS - 60 * 60 * 1000; // 23h

function isEnabled() {
  return String(configService.get('UNSUBSCRIBE_ROTATION_ENABLED', 'true')).toLowerCase() === 'true';
}

async function getState() {
  const state = await jobStateService.get(JOB_NAME);
  return {
    enabled: isEnabled(),
    lastRunAt: state ? state.lastRunAt : null,
    lastResult: state ? state.lastResult : null,
    intervalMs: INTERVAL_MS,
  };
}

/**
 * Rotate every user's notificationToken.
 * @param {object} [opts]
 * @param {boolean} [opts.force] rotate even if a rotation ran recently (manual admin trigger)
 * @param {string}  [opts.trigger]
 */
async function rotateAll({ force = false, trigger = 'interval' } = {}) {
  if (!isEnabled() && !force) {
    // Do NOT stamp lastRunAt here — otherwise re-enabling within the day would
    // make the due-check skip the first real rotation.
    logger.info(`[unsubscribeRotation] disabled — skipped (${trigger})`);
    return { skipped: true, reason: 'disabled' };
  }

  const User = mdb.INTERNAL && mdb.INTERNAL.user;
  if (!User) return { skipped: true, reason: 'no-model' };

  if (!force) {
    const state = await jobStateService.get(JOB_NAME);
    const last = state && state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
    if (last && Date.now() - last < DUE_AFTER_MS) {
      logger.info(`[unsubscribeRotation] last rotation ${new Date(last).toISOString()} still fresh — skipped (${trigger})`);
      return { skipped: true, reason: 'not-due', lastRunAt: new Date(last) };
    }
  }

  const users = await User.find({}).select('_id').lean();
  let rotated = 0;
  for (const u of users) {
    try {
      await User.updateOne({ _id: u._id }, { notificationToken: crypto.randomBytes(24).toString('hex') });
      rotated++;
    } catch (err) {
      logger.warn(`[unsubscribeRotation] failed to rotate user ${u._id}: ${err.message}`);
    }
  }

  await jobStateService.record(JOB_NAME, { outcome: 'ok', result: { rotated, trigger } });
  logger.info(`[unsubscribeRotation] rotated ${rotated}/${users.length} users (${trigger})`);
  return { rotated, total: users.length, trigger };
}

export default { rotateAll, getState, isEnabled, JOB_NAME, INTERVAL_MS };
