/**
 * documentIngestService.js — gets new Paperless documents into hcs-app and
 * gives each its first processing state (Paperless migration H3).
 *
 * Two routes in, both idempotent:
 *
 *   - Webhook. A Paperless "Document added" workflow posts to
 *     POST /api/paperless/webhook, which ingests the document straight away.
 *   - Reconciliation. A scheduled job lists documents modified in the last
 *     PAPERLESS_RECONCILE_LOOKBACK_HOURS and ingests any that hcs-app is
 *     missing or holds a stale copy of, so a lost webhook is caught.
 *
 * After ingest, classifyDocument() sets the first state. It is derived from
 * the Paperless tags and fields using the H7 table, so a document that was
 * already entered or sent in Paperless is not put back into Needs Data Entry:
 *
 *   tag `added`                       → sent
 *   tag 22 or Credit Note field true  → manual_kashflow (creditNote)
 *   tag `data entry done`             → entered
 *   otherwise                         → awaiting_entry
 *   tag 4 / tag 11                    → excludedReason original_multiple / manually_added
 *   tag 21 (supplier statement)       → statementReviewed
 *
 * Invoices and supplier statements also get classifiedAt, which is how a
 * statement that isn't reviewed is told apart from one not classified yet.
 *
 * Classification only ever fills an empty state (compare-and-set on
 * processingState: null), so a repeated webhook or a reconciliation pass over
 * a document already classified changes nothing. It writes no NotificationLog
 * rows and sends nothing; the H7 backfill adds the log rows.
 *
 * Following Paperless (H6, until cutover). While people can still finish entry
 * in Paperless, a document already classified is moved *forward* when its
 * Paperless tags say it has progressed (`data entry done` → entered, `added`
 * → sent, credit note → manual_kashflow, tag 21 → reviewed). Each move fires
 * the matching notification with source 'paperless', which in shadow mode is
 * what H8 compares against what Paperless actually sent. A state is never
 * moved backwards this way. PAPERLESS_FOLLOW_TAGS=false turns it off.
 *
 * A document new to hcs-app (webhook, or reconciliation finding one with no
 * copy) fires the new-document notification (PB-1).
 */

import mdb from '../mongooseDatabaseService.js';
import __paperlessClient from './paperlessClient.js';
import __grabServicePaperless from '../grabServicePaperless.js';
import { hasTag } from '../../config/paperlessTagsConfig.js';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';
import { isInvoiceDocument, actorFromUser, transition, markStatementReviewed } from './documentStateService.js';
import { notifySafely } from './documentNotifyService.js';
import logger from '../../../services/loggerService.js';

const SYSTEM = actorFromUser(null);
const storedSystem = { userId: SYSTEM.userId, name: SYSTEM.name };
const CLASSIFY_NOTE = 'Derived from Paperless tags at ingest';

const CREDIT_NOTE_FIELD_ID = 58;

function isCreditNoteField(cf) {
  if (!cf) return false;
  const byId = Number(cf.fieldId ?? cf.field) === CREDIT_NOTE_FIELD_ID;
  const byName = /^\s*credit\s*note\s*$/i.test(String(cf.fieldName ?? cf.name ?? ''));
  return byId || byName;
}

const truthy = (v) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');

/**
 * The state a document should start in, read from its Paperless tags and
 * fields. Pure. `processingState` is null for anything but an invoice.
 * @param {object} doc - OcrDocument shape: { documentType, tags, customFields }
 */
export function initialStateFromPaperless(doc) {
  const tags = doc?.tags || [];
  const out = { processingState: null, creditNote: false, excludedReason: null, statementReviewed: false };

  if (isInvoiceDocument(doc)) {
    out.creditNote = hasTag(tags, 'notifiedCreditNote')
      || (doc.customFields || []).some((cf) => isCreditNoteField(cf) && truthy(cf.value));

    if (hasTag(tags, 'added')) out.processingState = 'sent';
    else if (out.creditNote) out.processingState = 'manual_kashflow';
    else if (hasTag(tags, 'dataEntryDone')) out.processingState = 'entered';
    else out.processingState = 'awaiting_entry';

    if (hasTag(tags, 'originalMultiInvoice')) out.excludedReason = 'original_multiple';
    else if (hasTag(tags, 'manuallyAddedToKashflow')) out.excludedReason = 'manually_added';
  } else if (isDocumentType(doc?.documentType, 'supplierStatement')) {
    out.statementReviewed = hasTag(tags, 'notifiedAdminStatement');
  }
  return out;
}

/**
 * The compare-and-set filter and update that classify `doc`, or null when
 * there is nothing to set. Pure.
 */
export function buildClassifyUpdate(doc, { now = new Date() } = {}) {
  const plan = initialStateFromPaperless(doc);
  const stamp = { at: now, by: storedSystem };
  const entry = (field, from, to) => ({ field, from, to, action: 'classify', at: now, by: storedSystem, note: CLASSIFY_NOTE });

  if (plan.processingState) {
    const $set = { processingState: plan.processingState, processingStateChanged: stamp, classifiedAt: now };
    const history = [entry('processingState', null, plan.processingState)];
    if (plan.creditNote) {
      Object.assign($set, { creditNote: true, creditNoteChanged: stamp });
      history.push(entry('creditNote', false, true));
    }
    if (plan.excludedReason) {
      Object.assign($set, { excludedReason: plan.excludedReason, excludedReasonChanged: stamp });
      history.push(entry('excludedReason', null, plan.excludedReason));
    }
    return {
      filter: { paperlessId: doc.paperlessId, processingState: null },
      update: { $set, $push: { processingHistory: { $each: history } } },
      result: plan,
    };
  }

  // Supplier statements are always stamped, reviewed or not, so the
  // Statements to Review queue only holds statements that were classified.
  if (isDocumentType(doc?.documentType, 'supplierStatement')) {
    const $set = { classifiedAt: now };
    const update = { $set };
    if (plan.statementReviewed && doc.statementReviewed !== true) {
      Object.assign($set, { statementReviewed: true, statementReviewedChanged: stamp });
      update.$push = { processingHistory: { $each: [entry('statementReviewed', false, true)] } };
    }
    return { filter: { paperlessId: doc.paperlessId, classifiedAt: null }, update, result: plan };
  }

  return null;
}

/**
 * Give an ingested document its first state. A no-op for a document that
 * already has one, or that nothing applies to (bank statements, remittances,
 * untyped uploads — those are picked up once a type is set).
 * @returns {Promise<{classified: boolean, state?: object, reason?: string}>}
 */
export async function classifyDocument(OcrDocument, paperlessId, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId documentType tags customFields processingState statementReviewed classifiedAt deletedInPaperlessAt')
    .lean();
  if (!doc) return { classified: false, reason: 'not-found' };
  if (doc.deletedInPaperlessAt) return { classified: false, reason: 'deleted' };
  if (doc.processingState || doc.classifiedAt) return { classified: false, reason: 'already-classified' };

  const built = buildClassifyUpdate(doc, { now });
  if (!built) return { classified: false, reason: 'nothing-to-set' };

  const updated = await OcrDocument.findOneAndUpdate(built.filter, built.update, { new: true }).lean();
  if (!updated) return { classified: false, reason: 'already-classified' };
  return { classified: true, state: built.result };
}

// ── Following Paperless until cutover (H6) ───────────────────────────

export function followEnabled() {
  return String(process.env.PAPERLESS_FOLLOW_TAGS ?? 'true').trim().toLowerCase() !== 'false';
}

const FORWARD = ['awaiting_entry', 'entered', 'sent'];

/** Which notification each followed step fires. */
export const STEP_NOTIFICATION = {
  complete_entry: 'john',
  mark_sent: 'kashflow',
  flag_credit_note: 'credit_note',
  mark_reviewed: 'statement',
};

/**
 * The steps that bring a classified document level with its Paperless tags.
 * Forward only. Pure.
 * @returns {string[]} transition actions, plus 'mark_reviewed' for statements
 */
export function followSteps(doc) {
  const plan = initialStateFromPaperless(doc);
  if (isInvoiceDocument(doc)) {
    const state = doc.processingState;
    if (!state) return [];
    if (plan.processingState === 'manual_kashflow') {
      return ['awaiting_entry', 'entered'].includes(state) ? ['flag_credit_note'] : [];
    }
    const from = FORWARD.indexOf(state);
    const to = FORWARD.indexOf(plan.processingState);
    if (from < 0 || to <= from) return [];
    return ['complete_entry', 'mark_sent'].slice(from, to);
  }
  if (isDocumentType(doc?.documentType, 'supplierStatement')) {
    return doc.classifiedAt && plan.statementReviewed && doc.statementReviewed !== true ? ['mark_reviewed'] : [];
  }
  return [];
}

/**
 * Apply followSteps() as the system user and return the steps that applied.
 * Each step is the same compare-and-set as a person's action, so a race with
 * someone acting in hcs-app at the same moment just loses quietly.
 */
export async function followPaperlessTags(OcrDocument, paperlessId, { now = new Date() } = {}) {
  if (!followEnabled()) return [];
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId documentType tags customFields processingState statementReviewed classifiedAt deletedInPaperlessAt')
    .lean();
  if (!doc || doc.deletedInPaperlessAt) return [];
  const applied = [];
  for (const step of followSteps(doc)) {
    const note = 'Followed a Paperless tag change';
    const res = step === 'mark_reviewed'
      ? await markStatementReviewed(OcrDocument, paperlessId, SYSTEM, { now })
      : await transition(OcrDocument, paperlessId, step, SYSTEM, { now, note });
    if (!res.ok || res.firstTime === false) break;
    applied.push(step);
  }
  if (applied.length) logger.info(`[paperless-ingest] Followed Paperless for paperlessId=${paperlessId}: ${applied.join(', ')}`);
  return applied;
}

/**
 * After an ingest: classify if new to hcs-app, otherwise follow Paperless,
 * then fire the notifications those changes call for.
 */
export async function syncDocument(OcrDocument, paperlessId, { now = new Date(), isNew = false, notify = notifySafely } = {}) {
  const classification = await classifyDocument(OcrDocument, paperlessId, { now });
  const followed = classification.classified ? [] : await followPaperlessTags(OcrDocument, paperlessId, { now });
  if (isNew) await notify('new_doc', paperlessId, { source: 'app' });
  for (const step of followed) await notify(STEP_NOTIFICATION[step], paperlessId, { source: 'paperless' });
  return { ...classification, followed };
}

/**
 * Pull the document id out of a Paperless webhook body. Accepts `doc_id`,
 * `document_id` or `id`, else parses the `/documents/<id>/` path out of
 * `doc_url`, the placeholder the existing Discord workflows already use.
 * @returns {number|null}
 */
export function parseWebhookDocumentId(body) {
  if (!body || typeof body !== 'object') return null;
  for (const key of ['doc_id', 'document_id', 'id']) {
    const raw = body[key];
    if (raw == null || raw === '') continue;
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) return n;
  }
  const url = body.doc_url ?? body.url;
  if (typeof url === 'string') {
    const m = url.match(/\/documents\/(\d+)(?:\/|$|\?)/);
    if (m) return Number(m[1]);
  }
  return null;
}

const defaultDeps = () => ({
  OcrDocument: mdb.PAPERLESS?.OcrDocument,
  ingestOne: (id) => __grabServicePaperless.ingestOnePaperlessDoc(id),
  connect: () => mdb.connect(),
});

/**
 * Webhook path: ingest one document fresh from Paperless, then classify it.
 * Safe to call any number of times for the same document.
 */
export async function handleDocumentAdded(paperlessId, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (d.connect) await d.connect();
  const OcrDocument = d.OcrDocument ?? mdb.PAPERLESS?.OcrDocument;
  if (!OcrDocument) throw new Error('PAPERLESS models not loaded.');

  await d.ingestOne(paperlessId);
  // "Document added" is the new-document event itself; the one-shot claim
  // stops a repeated delivery announcing it twice
  const classification = await syncDocument(OcrDocument, paperlessId, { now: d.now, isNew: true, notify: d.notify });
  logger.info(`[paperless-ingest] Document added: paperlessId=${paperlessId} classified=${classification.classified}${classification.state?.processingState ? ` state=${classification.state.processingState}` : ''}`);
  return { paperlessId, ...classification };
}

let reconcileRunning = false;

/**
 * Reconciliation path: catch documents whose webhook never arrived.
 *
 * Lists documents modified within the lookback window, ingests any hcs-app
 * has no copy of or an older copy of, then classifies every document in the
 * window. Bounded to the window on purpose: classifying the historical
 * backlog is the H7 backfill, which Jack runs by hand.
 */
export async function reconcileRecentDocuments(deps = {}) {
  if (reconcileRunning) {
    logger.warn('[paperless-ingest] Reconciliation already running — skipping.');
    return { skipped: true };
  }
  reconcileRunning = true;
  try {
    const d = { ...defaultDeps(), api: null, ...deps };
    if (d.connect) await d.connect();
    const OcrDocument = d.OcrDocument ?? mdb.PAPERLESS?.OcrDocument;
    if (!OcrDocument) throw new Error('PAPERLESS models not loaded.');
    const api = d.api ?? __paperlessClient.makeClient();

    const now = d.now ?? new Date();
    const hours = Number(d.lookbackHours ?? process.env.PAPERLESS_RECONCILE_LOOKBACK_HOURS ?? 48);
    const lookbackHours = Number.isFinite(hours) && hours > 0 ? hours : 48;
    const since = new Date(now.getTime() - lookbackHours * 3600 * 1000).toISOString();

    const recent = [];
    for (let page = 1; ; page += 1) {
      const data = await api.listDocuments({ page, pageSize: 100, modified__gte: since, fields: 'id,modified,added' });
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const r of results) if (Number.isInteger(r?.id)) recent.push(r);
      if (!data?.next || results.length === 0) break;
    }

    let ingested = 0, classified = 0, followed = 0, failed = 0;
    for (const r of recent) {
      try {
        const existing = await OcrDocument.findOne({ paperlessId: r.id }).select('modified').lean();
        const stale = !existing
          || !existing.modified
          || (r.modified && new Date(existing.modified) < new Date(r.modified));
        if (stale) {
          await d.ingestOne(r.id);
          ingested++;
        }
        // Added inside the window = new; if its webhook was missed, this
        // announces it, and the one-shot claim stops a second announcement
        const isNew = Boolean(r.added && new Date(r.added) >= new Date(since));
        const c = await syncDocument(OcrDocument, r.id, { now, isNew, notify: d.notify });
        if (c.classified) classified++;
        followed += c.followed.length;
      } catch (err) {
        failed++;
        logger.warn(`[paperless-ingest] Reconciliation failed for paperlessId=${r.id}: ${err.message}`);
      }
    }

    const summary = { seen: recent.length, ingested, classified, followed, failed, lookbackHours };
    if (ingested || classified || followed || failed) {
      logger.info(`[paperless-ingest] Reconciliation: seen=${recent.length} ingested=${ingested} classified=${classified} followed=${followed} failed=${failed}`);
    }
    return summary;
  } finally {
    reconcileRunning = false;
  }
}

export default {
  initialStateFromPaperless,
  buildClassifyUpdate,
  classifyDocument,
  followEnabled,
  followSteps,
  followPaperlessTags,
  syncDocument,
  parseWebhookDocumentId,
  handleDocumentAdded,
  reconcileRecentDocuments,
};
