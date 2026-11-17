// Job Register lifecycle hooks: what should happen when a job moves on.
//
//   onQuoteAdded(job, quote)  a quote was added to a job (or a job created with one)
//   onJobWon(job)             the job's stage became won
//   onJobCompleted(job)       the job's stage became completed or invoiced
//
// For now they only log. Later they create the KashFlow project when a job is
// won, the OneDrive folders, and so on. The register's form saves call
// fireStageHooks with the job before and after, so a hook runs once, when the
// stage actually changes. A hook that fails is logged and never stops a save.
//
// The workbook import doesn't call them: a bulk import of old jobs shouldn't
// set off what a new win would.
import logger from '../../services/loggerService.js';
import { stageOf } from './jobRegisterService.js';

const DONE = new Set(['completed', 'invoiced']);
const WON_OR_LATER = new Set(['won', 'completed', 'invoiced']);

const label = (job) => (job?.projectNumber != null ? `job ${job.projectNumber}` : `job ${job?.uuid || ''}`.trim());

export async function onQuoteAdded(job, quote) {
  logger.info(`[jobRegisterLifecycle] Quote ${quote?.number ?? '(no number)'} added to ${label(job)}`);
}

export async function onJobWon(job) {
  logger.info(`[jobRegisterLifecycle] ${label(job)} won`);
}

export async function onJobCompleted(job) {
  logger.info(`[jobRegisterLifecycle] ${label(job)} completed`);
}

/**
 * Which hooks a stage change calls, by name. `before` is null for a new job.
 * Won when the stage reaches won (or later) from before it; completed when
 * it reaches completed or invoiced from anything else. Pure.
 */
export function stageHooks(before, after) {
  const from = before ? stageOf(before) : null;
  const to = stageOf(after);
  if (from === to || to === 'cancelled') return [];
  const out = [];
  if (WON_OR_LATER.has(to) && !WON_OR_LATER.has(from)) out.push('onJobWon');
  if (DONE.has(to) && !DONE.has(from)) out.push('onJobCompleted');
  return out;
}

const HOOKS = { onJobWon, onJobCompleted };

/** Run the hooks a save's stage change calls. Never throws. Returns the names run. */
export async function fireStageHooks(before, after, hooks = lifecycle) {
  const names = stageHooks(before, after);
  for (const name of names) {
    try {
      await hooks[name](after);
    } catch (err) {
      logger.warn(`[jobRegisterLifecycle] ${name} failed for ${label(after)}: ${err.message}`);
    }
  }
  return names;
}

/** Run onQuoteAdded. Never throws. */
export async function fireQuoteAdded(job, quote, hooks = lifecycle) {
  try {
    await hooks.onQuoteAdded(job, quote);
  } catch (err) {
    logger.warn(`[jobRegisterLifecycle] onQuoteAdded failed for ${label(job)}: ${err.message}`);
  }
}

// The object the save paths call through, so tests can swap a hook
const lifecycle = { onQuoteAdded, ...HOOKS, stageHooks, fireStageHooks, fireQuoteAdded };
export default lifecycle;
