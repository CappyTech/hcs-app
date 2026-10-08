/**
 * backfillService.js — the H7 migration (PAPERLESS-MIGRATION.md H7).
 *
 * Gives every document already in hcs-app the state Paperless says it is in,
 * and records the notifications Paperless has already sent, so that nothing
 * historical fires once hcs-app takes over sending:
 *
 *   Paperless             hcs-app
 *   `added`               state sent, plus a `kashflow` log row
 *   tag 21                statementReviewed, plus a `statement` log row
 *   tag 22 or field 58    creditNote (state manual_kashflow), plus a `credit_note` log row
 *   tag 19                a `john` log row
 *   tags 4 and 11         excludedReason
 *
 * The state comes from initialStateFromPaperless(), the same function H3 uses
 * on new documents, and every invoice and statement gets classifiedAt.
 *
 * Idempotent: classification is a compare-and-set on an empty state, log rows
 * are claimed under the one-shot unique index (status `recorded`, source
 * `backfill`), and a document that already has a state is never changed
 * beyond stamping a missing classifiedAt. Running it twice changes nothing
 * the second time. Paperless is only read, never written.
 */

import { initialStateFromPaperless, buildClassifyUpdate } from './documentIngestService.js';
import { isInvoiceDocument } from './documentStateService.js';
import { claimOneShot } from './notificationLogService.js';
import { hasTag } from '../../config/paperlessTagsConfig.js';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';

export const BACKFILL_NOTE = 'H7 backfill from Paperless tags';

const isStatement = (doc) => isDocumentType(doc?.documentType, 'supplierStatement');

/** The notifications Paperless has already sent for a document, from its tags. Pure. */
export function sentNotifications(doc) {
  const kinds = [];
  const tags = doc?.tags || [];
  const plan = initialStateFromPaperless(doc);
  if (hasTag(tags, 'added')) kinds.push('kashflow');
  if (isStatement(doc) && plan.statementReviewed) kinds.push('statement');
  if (isInvoiceDocument(doc) && plan.creditNote) kinds.push('credit_note');
  if (hasTag(tags, 'notifiedJohn')) kinds.push('john');
  return kinds;
}

/**
 * What the backfill would do to one document. Pure.
 * @returns {{classify: object|null, stampClassifiedAt: boolean, notifications: string[], state: string|null}}
 */
export function planDocument(doc, { now = new Date() } = {}) {
  const relevant = isInvoiceDocument(doc) || isStatement(doc);
  const alreadyClassified = Boolean(doc.processingState || doc.classifiedAt);
  const classify = relevant && !alreadyClassified
    ? buildClassifyUpdate(doc, { now, action: 'backfill', note: BACKFILL_NOTE })
    : null;
  return {
    classify,
    // Documents H3 classified before 6.45.1 have a state but no classifiedAt
    stampClassifiedAt: relevant && alreadyClassified && !doc.classifiedAt,
    notifications: sentNotifications(doc),
    state: classify?.result?.processingState ?? doc.processingState ?? null,
  };
}

const SELECT = 'paperlessId title documentType tags customFields processingState statementReviewed classifiedAt deletedInPaperlessAt';

/**
 * Run the backfill over every document hcs-app holds.
 * @param {{OcrDocument, NotificationLog, apply?: boolean, now?: Date, log?: Function}} opts
 *   apply=false (the default) changes nothing and reports what would happen.
 */
export async function runBackfill({ OcrDocument, NotificationLog, apply = false, now = new Date(), log = () => {} } = {}) {
  if (!OcrDocument || !NotificationLog) throw new Error('OcrDocument and NotificationLog are required');

  const summary = {
    apply,
    documents: 0,
    skippedDeleted: 0,
    classified: 0,
    byState: {},
    statementsClassified: 0,
    statementsReviewed: 0,
    excluded: { original_multiple: 0, manually_added: 0, not_for_kashflow: 0 },
    classifiedAtStamped: 0,
    notificationsRecorded: { kashflow: 0, statement: 0, credit_note: 0, john: 0 },
    notificationsAlreadyThere: 0,
    alreadyDone: 0,
  };

  const docs = await OcrDocument.find({}).select(SELECT).lean();
  for (const doc of docs) {
    summary.documents++;
    if (doc.deletedInPaperlessAt) { summary.skippedDeleted++; continue; }
    const plan = planDocument(doc, { now });
    let changed = false;

    if (plan.classify) {
      const updated = apply
        ? await OcrDocument.findOneAndUpdate(plan.classify.filter, plan.classify.update, { new: true }).lean()
        : true;
      if (updated) {
        changed = true;
        const r = plan.classify.result;
        if (r.processingState) {
          summary.classified++;
          summary.byState[r.processingState] = (summary.byState[r.processingState] || 0) + 1;
          if (r.excludedReason) summary.excluded[r.excludedReason]++;
        } else {
          summary.statementsClassified++;
          if (r.statementReviewed) summary.statementsReviewed++;
        }
      }
    } else if (plan.stampClassifiedAt) {
      const res = apply
        ? await OcrDocument.updateOne({ paperlessId: doc.paperlessId, classifiedAt: null }, { $set: { classifiedAt: now } })
        : { modifiedCount: 1 };
      if (res.modifiedCount) { changed = true; summary.classifiedAtStamped++; }
    }

    for (const kind of plan.notifications) {
      if (!apply) {
        const exists = await NotificationLog.exists({ paperlessId: doc.paperlessId, kind, oneShot: true });
        if (exists) summary.notificationsAlreadyThere++;
        else { summary.notificationsRecorded[kind]++; changed = true; }
        continue;
      }
      const claim = await claimOneShot(NotificationLog, doc.paperlessId, kind, { status: 'recorded', source: 'backfill' });
      if (claim.claimed) { summary.notificationsRecorded[kind]++; changed = true; } else summary.notificationsAlreadyThere++;
    }

    if (!changed) summary.alreadyDone++;
    if (summary.documents % 200 === 0) log(`… ${summary.documents} documents`);
  }
  return summary;
}

/** Plain-text report of a run. */
export function formatSummary(s) {
  const n = (x) => Number(x || 0).toLocaleString('en-GB');
  const verb = s.apply ? '' : 'would be ';
  const states = Object.entries(s.byState).map(([k, v]) => `${k} ${n(v)}`).join(', ') || 'none';
  const notes = Object.entries(s.notificationsRecorded).map(([k, v]) => `${k} ${n(v)}`).join(', ');
  return [
    `${s.apply ? 'APPLIED' : 'DRY RUN (nothing written; pass --apply to write)'}`,
    `Documents read: ${n(s.documents)} (deleted in Paperless, skipped: ${n(s.skippedDeleted)})`,
    `Invoices ${verb}classified: ${n(s.classified)} (${states})`,
    `  of which ${verb}kept out of the queues: original/multiple ${n(s.excluded.original_multiple)}, manually added ${n(s.excluded.manually_added)}, not for KashFlow ${n(s.excluded.not_for_kashflow)}`,
    `Supplier statements ${verb}classified: ${n(s.statementsClassified)} (already reviewed: ${n(s.statementsReviewed)})`,
    `Missing classifiedAt ${verb}stamped: ${n(s.classifiedAtStamped)}`,
    `Notifications ${verb}recorded as already sent: ${notes}`,
    `Notification rows already there: ${n(s.notificationsAlreadyThere)}`,
    `Documents with nothing to do: ${n(s.alreadyDone)}`,
  ].join('\n');
}

export default { BACKFILL_NOTE, sentNotifications, planDocument, runBackfill, formatSummary };
