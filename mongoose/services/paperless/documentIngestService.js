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
 *   tag 4 / tag 11 / not for kashflow → excludedReason original_multiple / manually_added / not_for_kashflow
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
 * Tags that keep an invoice out of entry (4 original/multiple, 11 manually
 * added to kashflow) are followed for as long as the invoice is waiting for
 * entry or to be sent, whatever PAPERLESS_FOLLOW_TAGS says: Paperless is still
 * where people mark them. Adding one excludes the invoice; removing it lets
 * the invoice back in, unless the exclusion was set by a person.
 *
 * A document new to hcs-app (webhook, or reconciliation finding one with no
 * copy) fires the new-document notification (PB-1).
 */

import mdb from '../mongooseDatabaseService.js';
import __paperlessClient from './paperlessClient.js';
import __grabServicePaperless from '../grabServicePaperless.js';
import { hasTag, PAPERLESS_TAGS, tagNamePatterns } from '../../config/paperlessTagsConfig.js';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';
import { isInvoiceDocument, actorFromUser, transition, markStatementReviewed, setExcludedReason } from './documentStateService.js';
import { notifySafely } from './documentNotifyService.js';
import { readSoon } from './documentReadingService.js';
import { refreshTypeCheck } from './documentTypeCheck.js';
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

/** Documents carrying any of the given tags, by id or known name. */
const hasAnyTagQuery = (keys) => ({
  tags: { $elemMatch: { $or: keys.flatMap((k) => [{ id: PAPERLESS_TAGS[k].id }, { name: { $in: tagNamePatterns(k) } }]) } },
});

const truthy = (v) => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');

/**
 * The state a document should start in, read from its Paperless tags and
 * fields. Pure. `processingState` is null for anything but an invoice.
 * @param {object} doc - OcrDocument shape: { documentType, tags, customFields, kashflowPurchaseId }
 * @param {{requireLink?: boolean}} [opts] - requireLink: `added` only means
 *   sent when the document is linked to a KashFlow purchase. Paperless's split
 *   copies the original's tags, so a page split off an entered PDF arrived
 *   tagged `added`, was marked In KashFlow without being in it, and had no link
 *   to unlink (#1177, #1178). The H7 backfill reads the tags as they are.
 */
export function initialStateFromPaperless(doc, { requireLink = false } = {}) {
  const tags = doc?.tags || [];
  const out = { processingState: null, creditNote: false, excludedReason: null, statementReviewed: false };

  if (isInvoiceDocument(doc)) {
    out.creditNote = hasTag(tags, 'notifiedCreditNote')
      || (doc.customFields || []).some((cf) => isCreditNoteField(cf) && truthy(cf.value));

    const added = hasTag(tags, 'added') && (!requireLink || doc.kashflowPurchaseId != null);
    if (added) out.processingState = 'sent';
    else if (out.creditNote) out.processingState = 'manual_kashflow';
    else if (hasTag(tags, 'dataEntryDone')) out.processingState = 'entered';
    else out.processingState = 'awaiting_entry';

    if (hasTag(tags, 'originalMultiInvoice')) out.excludedReason = 'original_multiple';
    else if (hasTag(tags, 'manuallyAddedToKashflow')) out.excludedReason = 'manually_added';
    else if (hasTag(tags, 'notForKashflow')) out.excludedReason = 'not_for_kashflow';
  } else if (isDocumentType(doc?.documentType, 'supplierStatement')) {
    out.statementReviewed = hasTag(tags, 'notifiedAdminStatement');
  }
  return out;
}

/**
 * The compare-and-set filter and update that classify `doc`, or null when
 * there is nothing to set. Pure.
 */
export function buildClassifyUpdate(doc, { now = new Date(), action = 'classify', note = CLASSIFY_NOTE, requireLink = false } = {}) {
  const plan = initialStateFromPaperless(doc, { requireLink });
  const stamp = { at: now, by: storedSystem };
  const entry = (field, from, to) => ({ field, from, to, action, at: now, by: storedSystem, note });

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
    .select('paperlessId documentType tags customFields processingState statementReviewed classifiedAt deletedInPaperlessAt kashflowPurchaseId')
    .lean();
  if (!doc) return { classified: false, reason: 'not-found' };
  if (doc.deletedInPaperlessAt) return { classified: false, reason: 'deleted' };
  if (doc.processingState || doc.classifiedAt) return { classified: false, reason: 'already-classified' };

  const built = buildClassifyUpdate(doc, { now, requireLink: true });
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
  // `added` without a purchase is a copied tag, not a send (see initialStateFromPaperless)
  const plan = initialStateFromPaperless(doc, { requireLink: true });
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
    .select('paperlessId documentType tags customFields processingState statementReviewed classifiedAt deletedInPaperlessAt kashflowPurchaseId')
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

// ── Tags that keep an invoice out of entry ───────────────────────────

const EXCLUDABLE_STATES = ['awaiting_entry', 'entered'];
const EXCLUSION_NOTE = 'Followed a Paperless tag change';

/**
 * The exclusion `doc` should have now, from its tags. Pure.
 * @returns {{from, to}|null} null when nothing should change
 */
export function exclusionChange(doc) {
  if (!isInvoiceDocument(doc) || !EXCLUDABLE_STATES.includes(doc.processingState) || doc.deletedInPaperlessAt) return null;
  const from = doc.excludedReason ?? null;
  const to = initialStateFromPaperless(doc).excludedReason;
  if (to === from) return null;
  if (to) return { from, to };
  // Tag gone: only undo an exclusion that came from a tag in the first place
  const by = doc.excludedReasonChanged?.by;
  const bySystem = !by || (by.userId == null && (by.name == null || by.name === SYSTEM.name));
  return bySystem ? { from, to: null } : null;
}

/** Bring one invoice's exclusion level with its Paperless tags. */
export async function followExclusionTags(OcrDocument, paperlessId, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId documentType tags customFields processingState excludedReason excludedReasonChanged deletedInPaperlessAt')
    .lean();
  const change = exclusionChange(doc);
  if (!change) return null;
  const res = await setExcludedReason(OcrDocument, paperlessId, change.to, SYSTEM, { now, note: EXCLUSION_NOTE });
  if (!res.ok || !res.changed) return null;
  logger.info(`[paperless-ingest] paperlessId=${paperlessId} ${change.to ? `excluded (${change.to})` : 'no longer excluded'}: followed its Paperless tags`);
  return change;
}

/**
 * Every invoice waiting for entry or sending whose exclusion doesn't match
 * its cached tags, put right. Catches tags added in Paperless after the
 * invoice arrived and outside the reconciliation window. Idempotent.
 */
export async function applyExclusionTags(OcrDocument, { now = new Date() } = {}) {
  const docs = await OcrDocument.find({
    processingState: { $in: EXCLUDABLE_STATES },
    deletedInPaperlessAt: null,
    $or: [
      { excludedReason: null, ...hasAnyTagQuery(['originalMultiInvoice', 'manuallyAddedToKashflow', 'notForKashflow']) },
      { excludedReason: { $ne: null } },
    ],
  }).select('paperlessId').lean();
  const excluded = [];
  const cleared = [];
  for (const { paperlessId } of docs) {
    try {
      const change = await followExclusionTags(OcrDocument, paperlessId, { now });
      if (change) (change.to ? excluded : cleared).push(paperlessId);
    } catch (err) {
      logger.warn(`[paperless-ingest] Following the exclusion tags on ${paperlessId} failed: ${err.message}`);
    }
  }
  return { excluded, cleared };
}

/**
 * After an ingest: classify if new to hcs-app, otherwise follow Paperless,
 * then fire the notifications those changes call for.
 */
export async function syncDocument(OcrDocument, paperlessId, { now = new Date(), isNew = false, notify = notifySafely } = {}) {
  const classification = await classifyDocument(OcrDocument, paperlessId, { now });
  const followed = classification.classified ? [] : await followPaperlessTags(OcrDocument, paperlessId, { now });
  const exclusion = classification.classified ? null : await followExclusionTags(OcrDocument, paperlessId, { now });
  await refreshTypeCheck(OcrDocument, paperlessId, { now }).catch((err) => {
    logger.warn(`[paperless-ingest] Type check for ${paperlessId} failed: ${err.message}`);
  });
  if (isNew) await notify('new_doc', paperlessId, { source: 'app' });
  for (const step of followed) await notify(STEP_NOTIFICATION[step], paperlessId, { source: 'paperless' });
  return { ...classification, followed, exclusion };
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
  // Read the invoice's PDF in the background, so the queue shows what's on it
  if (classification.state?.processingState === 'awaiting_entry') (d.readSoon ?? readSoon)(paperlessId).catch(() => {});
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
  exclusionChange,
  followExclusionTags,
  applyExclusionTags,
  syncDocument,
  parseWebhookDocumentId,
  handleDocumentAdded,
  reconcileRecentDocuments,
};
