/**
 * jobStateService — read/write persisted last-run state for background jobs.
 *
 * The scheduler itself is in-memory; jobs that must remember when they last ran
 * across restarts/reboots use this. Best-effort and defensive: a missing model
 * or DB error never throws into a job run.
 */

import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

function model() {
  return mdb.INTERNAL && mdb.INTERNAL.jobState;
}

/** @returns {Promise<object|null>} the persisted state for `name`, or null. */
async function get(name) {
  const JobState = model();
  if (!JobState || !name) return null;
  try {
    return await JobState.findOne({ name }).lean();
  } catch (err) {
    logger.warn(`[jobStateService] get(${name}) failed: ${err.message}`);
    return null;
  }
}

/** Upsert the last-run record for `name`. */
async function record(name, { outcome = 'ok', result = null, error = null } = {}) {
  const JobState = model();
  if (!JobState || !name) return null;
  try {
    return await JobState.findOneAndUpdate(
      { name },
      { lastRunAt: new Date(), lastOutcome: outcome, lastResult: result, lastError: error },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (err) {
    logger.warn(`[jobStateService] record(${name}) failed: ${err.message}`);
    return null;
  }
}

export default { get, record };
