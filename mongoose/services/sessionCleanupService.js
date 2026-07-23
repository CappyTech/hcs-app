import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

let intervalHandle = null;

async function cleanupOnce() {
  try {
    const now = new Date();
  const result = await mdb.INTERNAL.session.deleteMany({ expires: { $lte: now } });
    if (result.deletedCount) {
      logger.info(`[SESSION CLEANUP] Removed ${result.deletedCount} expired sessions`);
    }
  } catch (e) {
    logger.error('[SESSION CLEANUP] Error: ' + e.message);
  }
}

function start(intervalMs = 5 * 60 * 1000) { // default every 5 minutes
  if (intervalHandle) return;
  cleanupOnce(); // initial
  intervalHandle = setInterval(cleanupOnce, intervalMs).unref();
  logger.info('[SESSION CLEANUP] Scheduled every ' + (intervalMs/1000) + 's');
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

export default { start, stop, cleanupOnce };
