/**
 * documentQueueService.js — the three document queues (Paperless migration H4).
 *
 * Queues are driven by hcs-app state (H2), not Paperless tags or the inbox,
 * so a document opened and saved without being completed stays where it is
 * (PB-11). Each mirrors a Paperless saved view:
 *
 *   needs-entry  view 12  PI/SI, state awaiting_entry, no exclusion reason  (PB-3)
 *   ready        view 4   state entered                                     (PB-7)
 *   statements   view 13  Supplier Statement, not yet reviewed              (PB-10)
 *
 * A credit note (manual_kashflow) is in neither invoice queue (PB-12), and a
 * document deleted in Paperless is in no queue. All queues are oldest first.
 */

import { documentTypeQuery } from '../../config/paperlessTypesConfig.js';

const NOT_DELETED = { deletedInPaperlessAt: null };

const invoiceTypes = () => ({
  $or: [...documentTypeQuery('purchaseInvoice').$or, ...documentTypeQuery('subcontractorInvoice').$or],
});

export const QUEUES = {
  'needs-entry': {
    label: 'Needs Data Entry',
    icon: 'bi-pencil-square',
    description: 'Purchase and subcontractor invoices waiting for their details to be entered.',
    empty: 'Nothing is waiting for data entry.',
    filter: () => ({ ...invoiceTypes(), processingState: 'awaiting_entry', excludedReason: null, ...NOT_DELETED }),
  },
  ready: {
    label: 'Ready for KashFlow',
    icon: 'bi-send',
    description: 'Invoices with data entry complete, waiting to be sent to KashFlow.',
    empty: 'Nothing is waiting to be sent to KashFlow.',
    filter: () => ({ processingState: 'entered', ...NOT_DELETED }),
  },
  statements: {
    label: 'Statements to Review',
    icon: 'bi-file-earmark-text',
    description: 'Supplier statements nobody has reviewed yet.',
    empty: 'No supplier statements are waiting for review.',
    filter: () => ({ ...documentTypeQuery('supplierStatement'), statementReviewed: { $ne: true }, ...NOT_DELETED }),
  },
};

export const QUEUE_KEYS = Object.keys(QUEUES);

/** The Mongo filter for a queue. Throws on an unknown key. */
export function queueFilter(key) {
  const q = QUEUES[key];
  if (!q) throw new Error(`Unknown document queue "${key}"`);
  return q.filter();
}

/** Oldest first: when Paperless received it, then id for a stable order. */
export const QUEUE_SORT = { added: 1, paperlessId: 1 };

/**
 * Invoices with no state yet. Until the H7 backfill runs, older invoices sit
 * here rather than in a queue, and the page says so instead of looking empty.
 */
export function unclassifiedFilter() {
  return { ...invoiceTypes(), processingState: null, ...NOT_DELETED };
}

const LIST_FIELDS = 'paperlessId title correspondent documentType added created processingState excludedReason creditNote statementReviewed kashflowPurchaseNumber';

/** Whole days between `from` and `now`, or null. */
export function daysWaiting(from, now = new Date()) {
  if (!from) return null;
  const ms = now.getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null;
}

/**
 * One page of a queue plus the counts for every queue.
 * @returns {Promise<{key, queue, docs, total, page, pages, counts, unclassified}>}
 */
export async function loadQueue(OcrDocument, key, { page = 1, pageSize = 50, now = new Date() } = {}) {
  const filter = queueFilter(key);
  const [docs, countEntries, unclassified] = await Promise.all([
    OcrDocument.find(filter)
      .sort(QUEUE_SORT)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select(LIST_FIELDS)
      .lean(),
    Promise.all(QUEUE_KEYS.map(async (k) => [k, await OcrDocument.countDocuments(queueFilter(k))])),
    OcrDocument.countDocuments(unclassifiedFilter()),
  ]);
  const counts = Object.fromEntries(countEntries);
  const total = counts[key];
  return {
    key,
    queue: QUEUES[key],
    docs: docs.map((d) => ({ ...d, daysWaiting: daysWaiting(d.added, now) })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    counts,
    unclassified,
  };
}

/** Base of the Paperless web UI, for "open in Paperless" links. */
export function paperlessUiBase() {
  return (process.env.PAPERLESS_UI_URL
    || (process.env.PAPERLESS_BASE_URL || '').replace(/\/api\/?$/i, '')).replace(/\/+$/, '');
}

export default { QUEUES, QUEUE_KEYS, QUEUE_SORT, queueFilter, unclassifiedFilter, daysWaiting, loadQueue, paperlessUiBase };
