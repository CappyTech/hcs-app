/**
 * notificationLogService.js — the exactly-once ledger for document
 * notifications (Paperless migration H2).
 *
 * A one-shot notification (new_doc, john, kashflow, statement, credit_note)
 * is *claimed* by inserting its NotificationLog row before anything is sent.
 * The partial unique index on (paperlessId, kind) lets exactly one insert win;
 * every other caller gets `claimed: false` and must not send. This replaces
 * the `notified/*` tags in Paperless.
 *
 * Re-sends (john_resend) are recorded every time and never deduplicated.
 *
 * What happens to a claim whose send then fails (retry or leave) is decided
 * by the notification service in H6; completeNotification records the outcome.
 */

import { ONE_SHOT_KINDS, REPEATABLE_KINDS } from '../../models/mongoose/PAPERLESS/NotificationLog.js';

const isDuplicateKey = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ''));

const storedActor = (actor) => (actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null);

/**
 * Claim a one-shot notification for a document.
 * @returns {Promise<{claimed: true, entry} | {claimed: false, existing}>}
 */
export async function claimOneShot(NotificationLog, paperlessId, kind, { actor = null, mode = null, source = 'app', status = 'claimed' } = {}) {
  if (!ONE_SHOT_KINDS.includes(kind)) throw new Error(`"${kind}" is not a one-shot notification kind`);
  try {
    const entry = await NotificationLog.create({
      paperlessId,
      kind,
      status,
      mode,
      source,
      triggeredBy: storedActor(actor),
    });
    return { claimed: true, entry };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const existing = await NotificationLog.findOne({ paperlessId, kind, oneShot: true }).lean();
    return { claimed: false, existing };
  }
}

/** Record a repeatable notification (e.g. a re-send to John). Always inserts. */
export async function recordRepeatable(NotificationLog, paperlessId, kind, { actor = null, mode = null, source = 'app' } = {}) {
  if (!REPEATABLE_KINDS.includes(kind)) throw new Error(`"${kind}" is not a repeatable notification kind`);
  return NotificationLog.create({ paperlessId, kind, mode, source, triggeredBy: storedActor(actor) });
}

/** Record how a claimed/recorded notification went. */
export async function completeNotification(NotificationLog, id, { status, channels = [], error = null }) {
  if (!['sent', 'shadow', 'failed'].includes(status)) throw new Error(`Invalid completion status "${status}"`);
  await NotificationLog.updateOne({ _id: id }, { $set: { status, channels, error } });
}

/** True when a one-shot notification has already been claimed for the document. */
export async function hasOneShot(NotificationLog, paperlessId, kind) {
  return !!(await NotificationLog.exists({ paperlessId, kind, oneShot: true }));
}

export default { claimOneShot, recordRepeatable, completeNotification, hasOneShot };
