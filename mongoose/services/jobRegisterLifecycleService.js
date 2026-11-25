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
// kept on the job. Any other stage change that changes where the folder
// belongs (back a stage, cancelled, uncancelled) moves it there, and a changed
// site or number renames it (onFolderChange). The register's form saves call
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
 * kept on the job, and `say(folder)` may turn it into a success notice;
 * { skipped } (OneDrive off) does nothing and says nothing; an error is
 * logged and returned as a notice ("couldn't be <doing>").
 */
async function folderStep(job, doing, run, say = () => null) {
  try {
    const folder = await run();
    if (!folder || folder.skipped) return [];
    if (folder.id) await storeFolder(job.uuid, folder);
    const text = say(folder);
    return text ? [{ type: 'success', text }] : [];
  } catch (err) {
    logger.warn(`[jobRegisterLifecycle] OneDrive folder for ${label(job)} couldn't be ${doing}: ${err.message}`);
    auditFailed(job, doing, err);
    return [{ type: 'error', text: `The OneDrive folder couldn't be ${doing}: ${err.message}` }];
  }
}

/** What a sync did, in a sentence, or null when it changed nothing. Pure. */
export function syncSaid(folder) {
  if (!folder?.id) return null;
  const where = folder.path || folder.name;
  if (folder.created) return `Made the OneDrive folder: ${where}.`;
  if (folder.moved) return `Moved the OneDrive folder to ${where}.`;
  if (folder.renamed) return `Renamed the OneDrive folder to "${folder.name}".`;
  return null;
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

/** The values syncJobFolder needs, from a job. */
function syncArgs(job) {
  const q = folderQuote(job);
  return {
    stage: stageOf(job), quoteNumber: q?.number, projectNumber: job.projectNumber, site: job.site,
    quoteDate: q?.date, wonDate: job.jobDate || undefined, folderId: job.oneDriveFolderId || undefined,
  };
}

/**
 * The site or a number the folder is named from changed, so its name should
 * change too: the site (up to its first comma), the project number, or (for
 * a job with no project number) the quote it's named from. Pure.
 */
export function renameNeeded(before, after) {
  if (!before || !after) return false;
  if (oneDrive.siteForFolder(before.site) !== oneDrive.siteForFolder(after.site)) return true;
  if (before.projectNumber != null && after.projectNumber != null) return Number(before.projectNumber) !== Number(after.projectNumber);
  if (after.projectNumber == null) {
    const a = folderQuote(before)?.number;
    const b = folderQuote(after)?.number;
    return a != null && b != null && Number(a) !== Number(b);
  }
  return false;
}

/**
 * A change the forward hooks don't cover: the folder is moved to where the
 * job's stage now puts it (back to quotes or live jobs, into or out of
 * Cancelled) and renamed when the site or number changed. Only for a job that
 * has its folder: one without is left to the hooks and Sync folder.
 */
export async function onFolderChange(given, before = null) {
  const job = await fresh(given);
  if (!job.oneDriveFolderId) return [];
  const rename = renameNeeded(before, job) ? 'always' : 'number';
  return folderStep(job, 'moved', () => oneDrive.syncJobFolder({ ...syncArgs(job), rename, create: false, step: 'stage' }), syncSaid);
}

/**
 * The job page's Sync folder: find the job's folder (the one kept on it,
 * else by its project and quote numbers), make one if there is none (not for
 * a cancelled job), put it where the job's stage says, named
 * "<number> <site>", and keep it. Returns { folder, linked } (folder null
 * when there is none and none could be made, with `cancelled` when that's
 * why) or { skipped } when OneDrive is off. Throws a 404 for a missing job;
 * OneDrive's errors are thrown on.
 */
export async function syncFolder(uuid) {
  const job = await mdb.INTERNAL.jobRegister.findOne({ uuid: String(uuid || '') }).lean();
  if (!job) throw Object.assign(new Error('That register entry no longer exists.'), { status: 404 });
  const args = syncArgs(job);
  if (args.projectNumber == null && args.quoteNumber == null && !args.folderId) return { folder: null };
  let folder;
  try {
    folder = await oneDrive.syncJobFolder({ ...args, rename: 'always', create: true, step: 'sync' });
  } catch (err) {
    auditFailed(job, 'synced', err);
    throw err;
  }
  if (folder?.skipped) return { skipped: folder.skipped };
  if (!folder?.id) return { folder: null, cancelled: args.stage === 'cancelled' };
  const linked = !folder.created && !sameId(folder.id, job.oneDriveFolderId);
  await storeFolder(job.uuid, folder);
  if (linked) {
    logger.info(`[jobRegisterLifecycle] Found the OneDrive folder for ${label(job)}: "${folder.path}"`);
    auditLog.record('onedrive_folder_linked', null, {
      meta: { job: label(job), jobUuid: job.uuid, path: folder.path || null, itemId: folder.id },
    });
  }
  return { folder, linked };
}

/**
 * Link every job with no folder to its folder in OneDrive, from one read of
 * the whole folder structure: by project number in the live jobs folders,
 * else by its quote numbers (the one it's named from first) in the quotes
 * folders. Nothing in OneDrive is created, moved or renamed. Returns
 * { checked, linked, notFound } or { skipped } when OneDrive is off.
 */
export async function linkAllFolders() {
  const index = await oneDrive.folderIndex();
  if (index?.skipped) return { skipped: index.skipped };
  const jobs = await mdb.INTERNAL.jobRegister.find({ oneDriveFolderId: { $in: [null, ''] } }).lean();
  const used = new Set();
  let linked = 0;
  for (const job of jobs) {
    const q = folderQuote(job);
    const quoteNos = [q?.number, ...(job.quotes || []).map((x) => x.number)].filter((n) => n != null).map(String);
    let hit = job.projectNumber != null ? index.live.get(String(job.projectNumber)) : null;
    for (const n of quoteNos) {
      if (hit) break;
      hit = index.quotes.get(n) || null;
    }
    if (!hit || used.has(hit.id)) continue;
    used.add(hit.id);
    await storeFolder(job.uuid, hit);
    linked += 1;
  }
  const out = { checked: jobs.length, linked, notFound: jobs.length - linked };
  logger.info(`[jobRegisterLifecycle] Linked ${linked} of ${jobs.length} jobs to their OneDrive folders`);
  auditLog.record('onedrive_folders_bulk_linked', null, { meta: out });
  return out;
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
 * invoiced from anything else. onFolderChange (last) when the job's folder
 * belongs somewhere else and neither of those moves it, or when its site or
 * number changed. Pure.
 */
export function stageHooks(before, after) {
  const from = before ? stageOf(before) : null;
  const to = stageOf(after);
  const out = [];
  if (to !== 'cancelled') {
    const numbered = before != null && before.projectNumber == null && after?.projectNumber != null;
    if (WON_OR_LATER.has(to) && (!WON_OR_LATER.has(from) || numbered)) out.push('onJobWon');
    if (DONE.has(to) && !DONE.has(from)) out.push('onJobCompleted');
  }
  if (before != null) {
    const moves = oneDrive.STAGE_PLACE[from] !== oneDrive.STAGE_PLACE[to] && !out.length;
    if (moves || renameNeeded(before, after)) out.push('onFolderChange');
  }
  return out;
}

const HOOKS = { onJobWon, onJobCompleted, onFolderChange };

/** A hook's notices (`from`) onto `into`: only well-formed ones. */
function collect(from, into) {
  if (!Array.isArray(from) || !Array.isArray(into)) return;
  for (const n of from) {
    if (n && (n.type === 'success' || n.type === 'error') && n.text) into.push({ type: n.type, text: String(n.text) });
  }
}

/**
 * Run the hooks a save's stage change calls (each given the job after, then
 * before). Never throws. Returns the names
 * run; what they have to say is added to `notices`.
 */
export async function fireStageHooks(before, after, hooks = lifecycle, notices = []) {
  const names = stageHooks(before, after);
  for (const name of names) {
    try {
      collect(await hooks[name](after, before), notices);
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
const lifecycle = { onQuoteAdded, ...HOOKS, stageHooks, fireStageHooks, fireQuoteAdded, syncFolder, linkAllFolders, folderQuote, storeFolder, renameNeeded, syncSaid };
export default lifecycle;
