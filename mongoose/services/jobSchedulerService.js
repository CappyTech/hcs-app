import logger from '../../services/loggerService.js';
import auditContext from './auditContextService.js';

/**
 * Central background-job scheduler.
 *
 * Every periodic task in the app registers here instead of owning its own
 * setInterval. The scheduler provides per-job status (last run, duration,
 * outcome, error), a concurrency guard so a slow run is never overlapped by
 * the next tick, and manual triggering for the admin jobs page (/admin/jobs).
 */

const jobs = new Map();
let started = false;

/**
 * Register a job. Must be called before start().
 *
 * @param {string} name      – unique slug, e.g. 'session-cleanup'
 * @param {object} def
 * @param {string} def.description – human-readable summary for the admin UI
 * @param {number|null} def.intervalMs – how often to run, or null for a
 *                                       manual-only job (run via /admin/jobs)
 * @param {number} [def.initialDelayMs=10000] – delay before the first run
 * @param {Function} def.run       – async () => result (result is kept for status)
 */
function register(name, { description, intervalMs = null, initialDelayMs = 10_000, run }) {
  if (jobs.has(name)) {
    throw new Error(`[jobScheduler] Job already registered: ${name}`);
  }
  if (typeof run !== 'function') {
    throw new Error(`[jobScheduler] Job ${name} requires run()`);
  }
  jobs.set(name, {
    name,
    description: description || '',
    intervalMs,
    initialDelayMs,
    run,
    handle: null,
    initialHandle: null,
    running: false,
    lastRunAt: null,
    lastDurationMs: null,
    lastOutcome: null, // 'ok' | 'error'
    lastError: null,
    lastResult: null,
    nextRunAt: null,
    runCount: 0,
    failCount: 0,
  });
}

async function execute(job, trigger = 'interval') {
  if (job.running) {
    logger.warn(`[jobScheduler] ${job.name}: previous run still in progress — skipping ${trigger} run`);
    return { skipped: true };
  }
  job.running = true;
  job.lastRunAt = new Date();
  const startedAt = Date.now();
  try {
    // Attribute any DB writes this job makes to a named System actor in the audit log.
    const result = await auditContext.runAs(
      { actorId: null, actorName: `System (${job.name})`, actorEmail: '', ip: '', method: 'JOB', route: job.name },
      () => job.run(),
    );
    job.lastDurationMs = Date.now() - startedAt;
    job.lastOutcome = 'ok';
    job.lastError = null;
    job.lastResult = summarise(result);
    job.runCount++;
    return { ok: true, result };
  } catch (err) {
    job.lastDurationMs = Date.now() - startedAt;
    job.lastOutcome = 'error';
    job.lastError = err.message || String(err);
    job.failCount++;
    logger.error(`[jobScheduler] ${job.name} failed: ${job.lastError}`, { stack: err.stack });
    return { ok: false, error: job.lastError };
  } finally {
    job.running = false;
    if (started && job.handle) {
      job.nextRunAt = new Date(Date.now() + job.intervalMs);
    }
  }
}

// Keep stored results small and JSON-safe for the admin UI
function summarise(result) {
  if (result === undefined || result === null) return null;
  try {
    const json = JSON.stringify(result);
    return json.length > 500 ? json.slice(0, 500) + '…' : JSON.parse(json);
  } catch (_) {
    return String(result).slice(0, 500);
  }
}

/** Start all registered jobs. Idempotent. */
function start() {
  if (started) return;
  started = true;
  for (const job of jobs.values()) {
    if (!job.intervalMs) continue; // manual-only job — never scheduled
    job.initialHandle = setTimeout(() => {
      execute(job, 'initial');
      job.handle = setInterval(() => execute(job), job.intervalMs);
      if (job.handle.unref) job.handle.unref();
      job.nextRunAt = new Date(Date.now() + job.intervalMs);
    }, job.initialDelayMs);
    if (job.initialHandle.unref) job.initialHandle.unref();
    job.nextRunAt = new Date(Date.now() + job.initialDelayMs);
  }
  logger.info(`[jobScheduler] Started ${jobs.size} job(s): ${[...jobs.keys()].join(', ')}`);
}

/** Stop all jobs (used by tests and shutdown). */
function stop() {
  for (const job of jobs.values()) {
    if (job.initialHandle) clearTimeout(job.initialHandle);
    if (job.handle) clearInterval(job.handle);
    job.handle = null;
    job.initialHandle = null;
    job.nextRunAt = null;
  }
  started = false;
}

/** Manually run one job now (admin UI). Returns the execution outcome. */
async function runNow(name) {
  const job = jobs.get(name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  return execute(job, 'manual');
}

/** Status snapshot for the admin jobs page. */
function getStatus() {
  return [...jobs.values()].map((j) => ({
    name: j.name,
    description: j.description,
    intervalMs: j.intervalMs,
    running: j.running,
    lastRunAt: j.lastRunAt,
    lastDurationMs: j.lastDurationMs,
    lastOutcome: j.lastOutcome,
    lastError: j.lastError,
    lastResult: j.lastResult,
    nextRunAt: j.nextRunAt,
    runCount: j.runCount,
    failCount: j.failCount,
  }));
}

/** Test helper: clear the registry. */
function _reset() {
  stop();
  jobs.clear();
}

export default { register, start, stop, runNow, getStatus, _reset };
