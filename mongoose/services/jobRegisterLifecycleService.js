// Job Register lifecycle hooks: what should happen when a job moves on.
//
//   onQuoteAdded(job, quote)  a quote was added to a job (or a job created with one)
//   onJobWon(job)             the job's stage became won
//   onJobCompleted(job)       the job's stage became completed or invoiced
//
// With JOB_REGISTER_KASHFLOW_AUTO on, a quote added is created in KashFlow,
// and a won job gets its KashFlow project with its quotes put on it
// (jobRegisterKashflowService). With OneDrive job folders on, the first
// quote gets its folder, a won job's folder moves to the live jobs folder and
// a completed job's to Completed Jobs (oneDriveFolderService); the folder is
// kept on the job. The register's form saves call
// fireStageHooks with the job before and after, so a hook runs once, when the
// stage actually changes (and onJobWon again when a won job first gets its
// project number, since the project needs it).
//
// A hook returns notices ({ type: 'success' | 'error', text }) that the save
// passes back for the flash. A hook that fails is logged and never stops a
// save: the job is already saved when hooks run.
//
// The workbook import doesn't call them: a bulk import of old jobs shouldn't
// set off what a new win would.
import logger from '../../services/loggerService.js';
import auditLog from '../../services/auditLogService.js';
import { stageOf } from './jobRegisterService.js';
import kfCreate from './jobRegisterKashflowService.js';
import mdb from './mongooseDatabaseService.js';
import oneDrive from '../../services/oneDriveFolderService.js';

const DONE = new Set(['completed', 'invoiced']);
const WON_OR_LATER = new Set(['won', 'completed', 'invoiced']);

const label = (job) => (job?.projectNumber != null ? `job ${job.projectNumber}` : `job ${job?.uuid || ''}`.trim());

// ── OneDrive folders ────────────────────────────────────────────────────
//
// The folder service records each folder it creates or moves as a security
// event; here a step that fails and a folder found for a job are recorded,
// with the job they were for.

/** A folder step that failed, as a security event. */
function auditFailed(job, step, err) {
  auditLog.record('onedrive_folder_failed', null, {
    meta: { job: label(job), jobUuid: job?.uuid || null, step, error: err.message },
  });
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** The job as saved now (the KashFlow step may have changed a number), else as given. */
async function fresh(job) {
  try {
    return (await mdb.INTERNAL.jobRegister.findOne({ uuid: String(job?.uuid || '') }).lean()) || job;
  } catch (err) {
    logger.warn(`[jobRegisterLifecycle] Couldn't reload ${label(job)}: ${err.message}`);
    return job;
  }
}

/** Keep a folder (oneDriveFolderService result) on the job. */
export async function storeFolder(uuid, folder) {
  const $set = { oneDriveFolderId: String(folder.id) };
  const $unset = {};
  if (/^https:\/\//i.test(String(folder.webUrl || ''))) $set.oneDriveFolderUrl = String(folder.webUrl); else $unset.oneDriveFolderUrl = 1;
  if (folder.path) $set.oneDriveFolderPath = String(folder.path); else $unset.oneDriveFolderPath = 1;
  const update = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  await mdb.INTERNAL.jobRegister.updateOne({ uuid: String(uuid) }, update);
}

/**
 * Run one folder step: `run()` calls oneDriveFolderService. A folder back is
 * kept on the job; { skipped } (OneDrive off) does nothing and says nothing;
 * an error is logged and returned as a notice ("couldn't be <doing>").
 */
async function folderStep(job, doing, run) {
  try {
    const folder = await run();
    if (!folder || folder.skipped) return [];
    if (folder.id) await storeFolder(job.uuid, folder);
    return [];
  } catch (err) {
    logger.warn(`[jobRegisterLifecycle] OneDrive folder for ${label(job)} couldn't be ${doing}: ${err.message}`);
    auditFailed(job, doing, err);
    return [{ type: 'error', text: `The OneDrive folder couldn't be ${doing}: ${err.message}` }];
  }
}

/** The quote a job's folder is named from: its won quote, else its first. Pure. */
export function folderQuote(job) {
  const quotes = (job?.quotes || []).filter((q) => q.number != null);
  return quotes.find((q) => q.status === 'won') || quotes[0] || null;
}

/**
 * A quote added: its folder in the quotes folder, for the job's first quote
 * only. A variation, a job with its project number (it's live) or a job that
 * has a folder already uses the job's folder.
 */
async function quoteFolder(given, quote) {
  const job = await fresh(given);
  const first = (job.quotes || [])[0];
  const q = (job.quotes || []).find((x) => sameId(x._id, quote?._id)) || quote;
  if (job.oneDriveFolderId || job.projectNumber != null || job.cancelled || !q || q.number == null) return [];
  if (first && !sameId(first._id, q._id) && Number(first.number) !== Number(q.number)) return [];
  return folderStep(job, 'created', () => oneDrive.ensureQuoteFolder({ quoteNumber: q.number, site: job.site, quoteDate: q.date }));
}

/** A job won: its folder moved to the live jobs folder (or one made there). Needs the project number. */
async function liveFolder(given) {
  const job = await fresh(given);
  if (job.projectNumber == null || job.cancelled) return [];
  const q = folderQuote(job);
  return folderStep(job, 'moved to the live jobs folder', () => oneDrive.moveToLive({
    quoteNumber: q?.number, projectNumber: job.projectNumber, site: job.site, quoteDate: q?.date,
    wonDate: new Date(), folderId: job.oneDriveFolderId || undefined,
  }));
}

/** A job completed: its folder moved into Completed Jobs. Needs the project number. */
async function completedFolder(given) {
  const job = await fresh(given);
  if (job.projectNumber == null) return [];
  return folderStep(job, 'moved to Completed Jobs', () => oneDrive.moveToCompleted({
    projectNumber: job.projectNumber, site: job.site, wonDate: job.jobDate || undefined, folderId: job.oneDriveFolderId || undefined,
  }));
}

/**
 * The job page's Find folder: look the job's folder up in OneDrive by its
 * project and quote numbers and keep it. Returns { folder } (null when none
 * was found), { skipped } when OneDrive is off, or { already } when the job
 * has one. Throws a 404 for a missing job; OneDrive's errors are thrown on.
 */
export async function findFolder(uuid) {
  const job = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  if (!job) throw Object.assign(new Error('That register entry no longer exists.'), { status: 404 });
  if (job.oneDriveFolderId) return { already: true, folder: { id: job.oneDriveFolderId, webUrl: job.oneDriveFolderUrl, path: job.oneDriveFolderPath } };
  const q = folderQuote(job);
  if (job.projectNumber == null && !q) return { folder: null };
  let folder;
  try {
    folder = await oneDrive.findJobFolder({ quoteNumber: q?.number, projectNumber: job.projectNumber });
  } catch (err) {
    auditFailed(job, 'found', err);
    throw err;
  }
  if (folder?.skipped) return { skipped: folder.skipped };
  if (!folder?.id) return { folder: null };
  await storeFolder(job.uuid, folder);
  logger.info(`[jobRegisterLifecycle] Found the OneDrive folder for ${label(job)}: "${folder.path}"`);
  auditLog.record('onedrive_folder_linked', null, {
    meta: { job: label(job), jobUuid: job.uuid, path: folder.path || null, itemId: folder.id },
  });
  return { folder };
}

// ── The hooks ───────────────────────────────────────────────────────────

export async function onQuoteAdded(job, quote) {
  logger.info(`[jobRegisterLifecycle] Quote ${quote?.number ?? '(no number)'} added to ${label(job)}`);
  const kf = await kfCreate.autoCreateQuote(job, quote);
  return [...kf.notices, ...await quoteFolder(job, quote)];
}

export async function onJobWon(job) {
  logger.info(`[jobRegisterLifecycle] ${label(job)} won`);
  const kf = await kfCreate.autoJobWon(job);
  return [...kf.notices, ...await liveFolder(job)];
}

export async function onJobCompleted(job) {
  logger.info(`[jobRegisterLifecycle] ${label(job)} completed`);
  return completedFolder(job);
}

/**
 * Which hooks a stage change calls, by name. `before` is null for a new job.
 * Won when the stage reaches won (or later) from before it, or when a won
 * job first gets its project number; completed when it reaches completed or
 * invoiced from anything else. Pure.
 */
export function stageHooks(before, after) {
  const from = before ? stageOf(before) : null;
  const to = stageOf(after);
  if (to === 'cancelled') return [];
  const numbered = before != null && before.projectNumber == null && after?.projectNumber != null;
  const out = [];
  if (WON_OR_LATER.has(to) && (!WON_OR_LATER.has(from) || numbered)) out.push('onJobWon');
  if (DONE.has(to) && !DONE.has(from)) out.push('onJobCompleted');
  return out;
}

const HOOKS = { onJobWon, onJobCompleted };

/** A hook's notices (`from`) onto `into`: only well-formed ones. */
function collect(from, into) {
  if (!Array.isArray(from) || !Array.isArray(into)) return;
  for (const n of from) {
    if (n && (n.type === 'success' || n.type === 'error') && n.text) into.push({ type: n.type, text: String(n.text) });
  }
}

/**
 * Run the hooks a save's stage change calls. Never throws. Returns the names
 * run; what they have to say is added to `notices`.
 */
export async function fireStageHooks(before, after, hooks = lifecycle, notices = []) {
  const names = stageHooks(before, after);
  for (const name of names) {
    try {
      collect(await hooks[name](after), notices);
    } catch (err) {
      logger.warn(`[jobRegisterLifecycle] ${name} failed for ${label(after)}: ${err.message}`);
    }
  }
  return names;
}

/** Run onQuoteAdded. Never throws. What it has to say is added to `notices`. */
export async function fireQuoteAdded(job, quote, hooks = lifecycle, notices = []) {
  try {
    collect(await hooks.onQuoteAdded(job, quote), notices);
  } catch (err) {
    logger.warn(`[jobRegisterLifecycle] onQuoteAdded failed for ${label(job)}: ${err.message}`);
  }
}

// The object the save paths call through, so tests can swap a hook
const lifecycle = { onQuoteAdded, ...HOOKS, stageHooks, fireStageHooks, fireQuoteAdded, findFolder, folderQuote, storeFolder };
export default lifecycle;
