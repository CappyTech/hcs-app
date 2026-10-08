/**
 * documentStateService.js — processing state for Paperless documents
 * (Paperless migration H2).
 *
 * hcs-app owns where an invoice is in the process; Paperless tags no longer
 * decide it. Only Purchase and Subcontractor Invoices have a state:
 *
 *   initialise          (none)                  → awaiting_entry
 *   complete_entry      awaiting_entry          → entered
 *   mark_sent           entered                 → sent
 *   unlink              sent                    → entered   (unlink / orphaned purchase)
 *   unlink_unentered    sent                    → awaiting_entry   (unlink, nothing was ever entered)
 *   reopen_entry        entered                 → awaiting_entry   (admin)
 *   flag_credit_note    awaiting_entry, entered → manual_kashflow
 *   unflag_credit_note  manual_kashflow         → awaiting_entry   (admin)
 *
 * A flagged credit note leaves both invoice queues and is never offered for
 * the KashFlow send (PB-12); it is keyed into KashFlow by hand. An invoice
 * already in KashFlow must be unlinked before it can be flagged.
 *
 * Every write is a compare-and-set on the current state, so two concurrent
 * actions cannot both apply, and every change is appended to
 * processingHistory with who and when.
 */

import mongoose from 'mongoose';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';
import { EXCLUDED_REASONS } from '../../models/mongoose/PAPERLESS/OcrDocument.js';
// Circular (documentTypeCheck imports isInvoiceDocument from here); only used at call time
import { refreshTypeCheck } from './documentTypeCheck.js';

export const TRANSITIONS = {
  initialise:         { from: [null],                       to: 'awaiting_entry' },
  complete_entry:     { from: ['awaiting_entry'],           to: 'entered' },
  mark_sent:          { from: ['entered'],                  to: 'sent' },
  unlink:             { from: ['sent'],                     to: 'entered' },
  unlink_unentered:   { from: ['sent'],                     to: 'awaiting_entry' },
  reopen_entry:       { from: ['entered'],                  to: 'awaiting_entry', adminOnly: true },
  flag_credit_note:   { from: ['awaiting_entry', 'entered'], to: 'manual_kashflow', sets: { creditNote: true } },
  unflag_credit_note: { from: ['manual_kashflow'],          to: 'awaiting_entry', adminOnly: true, sets: { creditNote: false } },
};

/** Purchase or Subcontractor Invoice — the only documents with a state. */
export function isInvoiceDocument(doc) {
  const t = doc?.documentType;
  return isDocumentType(t, 'purchaseInvoice') || isDocumentType(t, 'subcontractorInvoice');
}

/**
 * Normalise req.user into an actor. `isAdmin` gates admin-only transitions
 * and is never stored.
 */
export function actorFromUser(user) {
  if (!user) return { userId: null, name: 'system', isAdmin: false };
  const rawId = user._id ?? user.id ?? null;
  return {
    userId: rawId != null && mongoose.isValidObjectId(rawId) ? rawId : null,
    name: user.username || user.name || user.email || null,
    isAdmin: user.role === 'admin',
  };
}

const storedActor = (actor) => (actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null);

/**
 * Decide whether `action` may apply to `doc`. Pure — no database access.
 * @returns {{ok: true, action, from, to, sets} | {ok: false, reason, message}}
 */
export function planTransition(doc, action, actor) {
  const rule = TRANSITIONS[action];
  if (!rule) return { ok: false, reason: 'unknown-action', message: `Unknown action "${action}".` };
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (!isInvoiceDocument(doc)) {
    return { ok: false, reason: 'not-invoice', message: 'Only purchase and subcontractor invoices have a processing state.' };
  }
  const from = doc.processingState ?? null;
  if (!rule.from.includes(from)) {
    return {
      ok: false,
      reason: 'invalid-state',
      message: `Can't ${action.replace(/_/g, ' ')} a document that is ${from ? from.replace(/_/g, ' ') : 'not yet classified'}.`,
    };
  }
  if (rule.adminOnly && !actor?.isAdmin) {
    return { ok: false, reason: 'forbidden', message: 'Only an admin can do this.' };
  }
  return { ok: true, action, from, to: rule.to, sets: rule.sets || {} };
}

/**
 * The compare-and-set filter and update for a successful plan. Pure.
 * The filter matches only while the document is still in `plan.from`.
 */
export function buildTransitionUpdate(paperlessId, plan, actor, { now = new Date(), note = null } = {}) {
  const by = storedActor(actor);
  const stamp = { at: now, by };
  const $set = { processingState: plan.to, processingStateChanged: stamp };
  const history = [{ field: 'processingState', from: plan.from, to: plan.to, action: plan.action, at: now, by, note }];

  for (const [field, value] of Object.entries(plan.sets)) {
    $set[field] = value;
    $set[`${field}Changed`] = stamp;
    history.push({ field, from: !value, to: value, action: plan.action, at: now, by, note });
  }

  return {
    filter: { paperlessId, processingState: plan.from },
    update: { $set, $push: { processingHistory: { $each: history } } },
  };
}

/**
 * Apply a state transition.
 * @param {mongoose.Model} OcrDocument
 * @param {number} paperlessId
 * @param {string} action - key of TRANSITIONS
 * @param {object} actor - from actorFromUser()
 * @param {{note?: string, now?: Date}} [opts]
 * @returns {Promise<{ok: true, from, to, doc} | {ok: false, reason, message}>}
 */
export async function transition(OcrDocument, paperlessId, action, actor, opts = {}) {
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId documentType processingState')
    .lean();
  const plan = planTransition(doc, action, actor);
  if (!plan.ok) return plan;

  const { filter, update } = buildTransitionUpdate(paperlessId, plan, actor, opts);
  const updated = await OcrDocument.findOneAndUpdate(filter, update, { new: true }).lean();
  if (!updated) {
    return { ok: false, reason: 'conflict', message: 'The document changed while you were working on it — reload and try again.' };
  }
  // A new state can settle or raise a type concern (a flagged credit note no
  // longer "looks like a credit note"), so don't wait for the hourly sweep (#267)
  await refreshTypeCheck(OcrDocument, paperlessId).catch(() => {});
  return { ok: true, from: plan.from, to: plan.to, doc: updated };
}

/**
 * Mark a supplier statement reviewed (PB-10). Only the first call changes
 * anything; `firstTime` tells the caller whether this call did it.
 */
export async function markStatementReviewed(OcrDocument, paperlessId, actor, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType statementReviewed').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (!isDocumentType(doc.documentType, 'supplierStatement')) {
    return { ok: false, reason: 'not-statement', message: 'Only supplier statements can be marked reviewed.' };
  }
  const by = storedActor(actor);
  const updated = await OcrDocument.findOneAndUpdate(
    { paperlessId, statementReviewed: { $ne: true } },
    {
      $set: { statementReviewed: true, statementReviewedChanged: { at: now, by } },
      $push: { processingHistory: { field: 'statementReviewed', from: false, to: true, action: 'mark_reviewed', at: now, by, note: null } },
    },
    { new: true },
  ).lean();
  if (updated) await refreshTypeCheck(OcrDocument, paperlessId, { now }).catch(() => {});
  return { ok: true, firstTime: !!updated };
}

/** Why an excluded document isn't entered or sent, for the person looking at it. */
export const EXCLUDED_MESSAGES = {
  original_multiple: 'This PDF holds several invoices (tagged "original/multiple invoice one pdf" in Paperless). '
    + "Each invoice is entered from its own document, so this one isn't entered or sent to KashFlow.",
  manually_added: 'This was keyed into KashFlow by hand (tagged "manually added to kashflow" in Paperless), '
    + "so it isn't entered or sent from here.",
  not_for_kashflow: "Marked not for KashFlow, so it isn't entered or sent.",
};

/** The reason `doc` is kept out of entry and sending, or null when it isn't. */
export function notForEntryMessage(doc) {
  const message = EXCLUDED_MESSAGES[doc?.excludedReason] || null;
  if (message && doc.excludedReason === 'not_for_kashflow' && doc.excludedNote) {
    return `${message} Reason: ${doc.excludedNote}`;
  }
  return message;
}

/**
 * Set or clear why a document is kept out of the invoice queues.
 * @param {'original_multiple'|'manually_added'|'not_for_kashflow'|null} reason
 * @param {object} [opts] note: for the history; excludedNote: why it's not for
 *   KashFlow, kept on the document (cleared with the exclusion)
 */
export async function setExcludedReason(OcrDocument, paperlessId, reason, actor, { now = new Date(), note = null, excludedNote = null } = {}) {
  if (reason != null && !EXCLUDED_REASONS.includes(reason)) {
    return { ok: false, reason: 'invalid-reason', message: `Unknown exclusion reason "${reason}".` };
  }
  const doc = await OcrDocument.findOne({ paperlessId }).select('excludedReason').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  const from = doc.excludedReason ?? null;
  if (from === reason) return { ok: true, changed: false };

  const by = storedActor(actor);
  const updated = await OcrDocument.findOneAndUpdate(
    { paperlessId, excludedReason: from },
    {
      $set: { excludedReason: reason, excludedReasonChanged: { at: now, by }, excludedNote: reason ? excludedNote : null },
      $push: { processingHistory: { field: 'excludedReason', from, to: reason, action: 'set_excluded', at: now, by, note } },
    },
    { new: true },
  ).lean();
  if (!updated) {
    return { ok: false, reason: 'conflict', message: 'The document changed while you were working on it — reload and try again.' };
  }
  return { ok: true, changed: true };
}

export default {
  TRANSITIONS,
  isInvoiceDocument,
  actorFromUser,
  planTransition,
  buildTransitionUpdate,
  transition,
  markStatementReviewed,
  setExcludedReason,
  notForEntryMessage,
  EXCLUDED_MESSAGES,
};
