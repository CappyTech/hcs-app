// Job Register lifecycle hooks: what should happen when a job moves on.
//
//   onQuoteAdded(job, quote)  a quote was added to a job (or a job created with one)
//   onJobWon(job)             the job's stage became won
//   onJobCompleted(job)       the job's stage became completed or invoiced
//
// With JOB_REGISTER_KASHFLOW_AUTO on, a quote added is created in KashFlow,
// and a won job gets its KashFlow project with its quotes put on it
// (jobRegisterKashflowService). The register's form saves call
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
import { stageOf } from './jobRegisterService.js';
import kfCreate from './jobRegisterKashflowService.js';

const DONE = new Set(['completed', 'invoiced']);
const WON_OR_LATER = new Set(['won', 'completed', 'invoiced']);

const label = (job) => (job?.projectNumber != null ? `job ${job.projectNumber}` : `job ${job?.uuid || ''}`.trim());

export async function onQuoteAdded(job, quote) {
  logger.info(`[jobRegisterLifecycle] Quote ${quote?.number ?? '(no number)'} added to ${label(job)}`);
  const kf = await kfCreate.autoCreateQuote(job, quote);
  return kf.notices;
}

export async function onJobWon(job) {
  logger.info(`[jobRegisterLifecycle] ${label(job)} won`);
  const kf = await kfCreate.autoJobWon(job);
  return kf.notices;
}

export async function onJobCompleted(job) {
  logger.info(`[jobRegisterLifecycle] ${label(job)} completed`);
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
const lifecycle = { onQuoteAdded, ...HOOKS, stageHooks, fireStageHooks, fireQuoteAdded };
export default lifecycle;
