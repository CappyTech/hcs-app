/**
 * shadowReportService.js — what hcs-app would have sent, against what
 * Paperless actually sent (Paperless migration H8).
 *
 * While NOTIFY_MODE=shadow, every notification hcs-app would send is recorded
 * in NotificationLog, and Paperless still does the sending. Paperless leaves
 * evidence of each send in its tags:
 *
 *   john         tag 19 notified/john           (WF3, and WF9 re-sends)
 *   kashflow     tag 20 notified/kashflow       (WF4)
 *   statement    tag 21 notified/admin-statement (WF2)
 *   credit_note  tag 22 notified/credit-note    (WF5)
 *   new_doc      no tag: WF8 posts for every document added
 *
 * For a window of time the report lists, per kind:
 *   matched  both sent (hcs-app's record and Paperless's tag agree)
 *   missing  Paperless sent, hcs-app recorded nothing        ← a gap in hcs-app
 *   extra    hcs-app would send, Paperless shows no sign     ← hcs-app would over-send
 *   pending  too recent to judge: hcs-app follows Paperless every 15 minutes
 *   gone     hcs-app recorded a send for a document since deleted in Paperless
 *            or removed from hcs-app: no copy left to compare, so not a mismatch
 *            (split copies #1174, #1175, #1177)
 *
 * Rows from the H7 backfill are history, not shadow sends, and are left out.
 * So is everything before shadow recording began (the first non-backfill
 * NotificationLog row): hcs-app can't have recorded a document that arrived
 * before it started looking.
 * Re-sends to John leave no trace in Paperless (WF9 removes `notify` again),
 * so they are counted but not compared.
 *
 * Reads only hcs-app's copy of each document; Paperless itself isn't called.
 */

import { hasTagQuery, hasTag } from '../../config/paperlessTagsConfig.js';
import { notifyMode, buildMessages } from './documentNotifyService.js';
import logger from '../../../services/loggerService.js';

export const COMPARED_KINDS = {
  john: { tag: 'notifiedJohn', workflow: 'WF3', label: 'Invoice emailed' },
  kashflow: { tag: 'notifiedKashflow', workflow: 'WF4', label: 'Added to KashFlow (Discord)' },
  statement: { tag: 'notifiedAdminStatement', workflow: 'WF2', label: 'Statement emailed' },
  credit_note: { tag: 'notifiedCreditNote', workflow: 'WF5', label: 'Credit note emailed' },
  new_doc: { tag: null, workflow: 'WF8', label: 'New document (Discord)' },
};

/** How long after a change the 15-minute follow job may still be catching up. */
export const PENDING_MS = 30 * 60 * 1000;

const DOC_FIELDS = 'paperlessId title originalFileName correspondent documentType created added modified tags deletedInPaperlessAt';

const recent = (d, now) => d && now.getTime() - new Date(d).getTime() < PENDING_MS;

const item = (doc, kind, extra = {}) => {
  const out = {
    paperlessId: doc?.paperlessId ?? extra.paperlessId,
    title: doc?.title || null,
    supplier: doc?.correspondent?.name || null,
    ...extra,
  };
  if (doc) {
    try { out.wouldSend = buildMessages(kind, doc).discord?.content || null; } catch { out.wouldSend = null; }
  }
  return out;
};

/**
 * Compare one window. Pure apart from the reads.
 * @returns {Promise<{from, to, mode, clean, kinds, totals, resends}>}
 */
/** When hcs-app started recording: its first non-backfill notification, or null. */
export async function shadowStartedAt(NotificationLog) {
  const [first] = await NotificationLog.find({ source: { $in: ['app', 'paperless'] } }).sort({ createdAt: 1 }).limit(1).lean();
  return first?.createdAt ? new Date(first.createdAt) : null;
}

export async function compareWindow({ OcrDocument, NotificationLog, from: requestedFrom, to, now = new Date(), shadowStart }) {
  const kinds = {};
  const totals = { matched: 0, missing: 0, extra: 0, pending: 0, gone: 0 };
  const started = shadowStart === undefined ? await shadowStartedAt(NotificationLog) : shadowStart;
  // Nothing recorded yet: an empty window rather than everything "missing"
  const from = started ? new Date(Math.max(requestedFrom.getTime(), started.getTime())) : to;

  for (const [kind, spec] of Object.entries(COMPARED_KINDS)) {
    const result = { label: spec.label, workflow: spec.workflow, matched: [], missing: [], extra: [], pending: [], gone: [] };

    // What Paperless sent in the window
    const paperlessDocs = spec.tag
      ? await OcrDocument.find({ ...hasTagQuery(spec.tag), modified: { $gte: from, $lt: to }, deletedInPaperlessAt: null }).select(DOC_FIELDS).lean()
      : await OcrDocument.find({ added: { $gte: from, $lt: to }, deletedInPaperlessAt: null }).select(DOC_FIELDS).lean();

    // What hcs-app recorded in the window (shadow or live, never backfill)
    const rows = await NotificationLog.find({ kind, createdAt: { $gte: from, $lt: to }, source: { $in: ['app', 'paperless'] } }).lean();

    // Every non-backfill row for the Paperless side's documents, whenever
    // recorded: a send just before midnight still matches a tag just after
    const ids = paperlessDocs.map((d) => d.paperlessId);
    // WF9 re-sends also add tag 19, so a re-send counts for the john tag
    const matchKinds = kind === 'john' ? ['john', 'john_resend'] : [kind];
    const anyRows = ids.length
      ? await NotificationLog.find({ kind: { $in: matchKinds }, paperlessId: { $in: ids } }).lean()
      : [];
    const rowsById = new Map();
    for (const r of anyRows) rowsById.set(r.paperlessId, [...(rowsById.get(r.paperlessId) || []), r]);

    const seen = new Set();
    for (const doc of paperlessDocs) {
      const docRows = rowsById.get(doc.paperlessId) || [];
      // A backfill row means Paperless's tag predates the shadow run: history, not a send
      if (docRows.some((r) => r.source === 'backfill')) continue;
      seen.add(doc.paperlessId);
      if (docRows.length) result.matched.push(item(doc, kind, { at: docRows[0].createdAt }));
      else if (recent(doc.modified, now) || recent(doc.added, now)) result.pending.push(item(doc, kind));
      else result.missing.push(item(doc, kind));
    }

    // hcs-app sends with no sign of Paperless sending
    const rowDocIds = [...new Set(rows.map((r) => r.paperlessId))].filter((id) => !seen.has(id));
    const rowDocs = rowDocIds.length
      ? await OcrDocument.find({ paperlessId: { $in: rowDocIds } }).select(DOC_FIELDS).lean()
      : [];
    const docById = new Map(rowDocs.map((d) => [d.paperlessId, d]));
    for (const id of rowDocIds) {
      const doc = docById.get(id);
      const row = rows.find((r) => r.paperlessId === id);
      if (!doc || doc.deletedInPaperlessAt) {
        result.gone.push(item(doc, kind, { paperlessId: id, at: row.createdAt, source: row.source }));
        continue;
      }
      const paperlessSent = spec.tag ? hasTag(doc.tags, spec.tag) : Boolean(doc.added);
      if (paperlessSent) result.matched.push(item(doc, kind, { at: row.createdAt }));
      else if (recent(row.createdAt, now)) result.pending.push(item(doc, kind, { paperlessId: id, at: row.createdAt }));
      else result.extra.push(item(doc, kind, { paperlessId: id, at: row.createdAt, source: row.source }));
    }

    for (const k of ['matched', 'missing', 'extra', 'pending', 'gone']) totals[k] += result[k].length;
    kinds[kind] = result;
  }

  const resends = await NotificationLog.find({ kind: 'john_resend', createdAt: { $gte: from, $lt: to } }).lean();
  return {
    from,
    to,
    requestedFrom,
    shadowStart: started,
    mode: notifyMode(),
    clean: totals.missing === 0 && totals.extra === 0,
    kinds,
    totals,
    resends: resends.length,
  };
}

/** [from, to) for a UTC calendar day 'YYYY-MM-DD'. */
export function dayWindow(day) {
  const from = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new Error(`Bad day "${day}"`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Save the report for a day (default: yesterday, UTC). Idempotent: saving the
 * same day again replaces it. The paperless-shadow-report job.
 */
export async function saveDailyReport({ OcrDocument, NotificationLog, ShadowReport, day = null, now = new Date() }) {
  const target = day || isoDay(new Date(now.getTime() - 86_400_000));
  const { from, to } = dayWindow(target);
  const report = await compareWindow({ OcrDocument, NotificationLog, from, to, now });
  await ShadowReport.updateOne(
    { day: target },
    { $set: { day: target, from, to, clean: report.clean, mode: report.mode, totals: report.totals, kinds: report.kinds, generatedAt: now } },
    { upsert: true },
  );
  logger.info(`[shadowReport] ${target}: ${report.clean ? 'clean' : 'MISMATCH'} matched=${report.totals.matched} missing=${report.totals.missing} extra=${report.totals.extra} pending=${report.totals.pending}`);
  return { day: target, ...report };
}

export default { COMPARED_KINDS, PENDING_MS, compareWindow, dayWindow, isoDay, saveDailyReport };
