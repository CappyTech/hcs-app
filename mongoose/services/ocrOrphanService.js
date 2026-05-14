'use strict';

const mdb    = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const INITIAL_DELAY_MS  = 15_000;               // 15 s after boot

let intervalHandle = null;

/**
 * Finds OcrDocuments whose kashflowPurchaseId no longer matches an active
 * (non-soft-deleted) REST purchase and nulls out the stale link fields.
 *
 * @returns {{ checked: number, cleared: number, errors: number }}
 */
async function detectAndClearOrphans() {
  const stats = { checked: 0, cleared: 0, errors: 0 };

  const OcrDocument = mdb.PAPERLESS?.OcrDocument;
  const Purchase    = mdb.REST?.purchase;

  if (!OcrDocument || !Purchase) {
    logger.warn('[ocrOrphanService] Models not available — skipping.');
    return stats;
  }

  // 1. All OcrDocuments that currently have a KashFlow purchase link,
  //    but only those sent more than 48 h ago. Documents sent recently may not
  //    have been picked up by hcs-sync yet, so we must not treat them as orphans.
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const linked = await OcrDocument
    .find({ kashflowPurchaseId: { $ne: null }, lastSentAt: { $lt: cutoff } })
    .select('_id kashflowPurchaseId')
    .lean();

  if (linked.length === 0) return stats;
  stats.checked = linked.length;

  // 2. Build the set of KashFlow IDs actually referenced by those docs
  const linkedIds = [...new Set(linked.map(d => d.kashflowPurchaseId).filter(id => id != null))];

  // 3. Query only the referenced purchases (avoids loading the full collection into memory).
  //    deletedAt: null / DeletedAt: null matches both null and missing field in MongoDB.
  const activePurchases = await Purchase
    .find({ Id: { $in: linkedIds }, deletedAt: null, DeletedAt: null })
    .select('Id')
    .lean();
  const activePurchaseIds = new Set(activePurchases.map(p => p.Id));

  // 3. Identify orphans — linked OcrDocs whose purchase is gone or soft-deleted
  const orphanIds = linked
    .filter(doc => !activePurchaseIds.has(doc.kashflowPurchaseId))
    .map(doc => doc._id);

  if (orphanIds.length === 0) {
    logger.debug(`[ocrOrphanService] No orphans found (${stats.checked} checked).`);
    return stats;
  }

  // 4. Null out the stale link fields in a single bulk update
  try {
    const result = await OcrDocument.updateMany(
      { _id: { $in: orphanIds } },
      {
        $set: {
          kashflowPurchaseId:     null,
          kashflowPurchaseNumber: null,
          kashflowPermalink:      null,
        },
      },
    );
    stats.cleared = result.modifiedCount;
    logger.warn(
      `[ocrOrphanService] Cleared ${stats.cleared} orphaned KashFlow link(s) ` +
      `(${stats.checked} checked).`,
    );
  } catch (err) {
    stats.errors++;
    logger.error('[ocrOrphanService] Bulk update failed: ' + err.message);
  }

  return stats;
}

function start() {
  if (intervalHandle) return;
  logger.info('[ocrOrphanService] Starting (initial delay 15 s, then every 24 h).');
  setTimeout(async () => {
    try { await detectAndClearOrphans(); }
    catch (err) { logger.error('[ocrOrphanService] Initial run failed: ' + err.message); }
  }, INITIAL_DELAY_MS);
  intervalHandle = setInterval(async () => {
    try { await detectAndClearOrphans(); }
    catch (err) { logger.error('[ocrOrphanService] Periodic run failed: ' + err.message); }
  }, CHECK_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = { detectAndClearOrphans, start, stop };
