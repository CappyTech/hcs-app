/**
 * kashflowSendClaimService.js
 *
 * Atomic double-submit guard for sending a Paperless OCR document to KashFlow.
 *
 * The previous protection was check-then-act: read the document, reject if
 * already linked, then spend up to 20s on the KashFlow HTTP call before
 * persisting the linkage. Two concurrent submits (double-click, two tabs,
 * retried request) both passed the check and created two purchases.
 *
 * claimSend() closes that window with a single findOneAndUpdate whose filter
 * only matches a document that is (a) not already successfully linked and
 * (b) not currently claimed by another in-flight send. Exactly one concurrent
 * caller can win the claim.
 *
 * A claim older than SEND_CLAIM_STALE_MS is treated as abandoned (crashed
 * process, lost connection) and can be taken over, so a failure to release
 * never wedges the document permanently.
 */

import logger from '../../../services/loggerService.js';

const SEND_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Atomically claim the document for sending.
 *
 * @param {mongoose.Model} OcrDocument — the PAPERLESS.OcrDocument model
 * @param {number} paperlessId
 * @param {object} [opts]
 * @param {number} [opts.staleMs] — claim age after which takeover is allowed
 * @returns {Promise<{ok: true} | {ok: false, reason: string, message: string, purchaseId?: number}>}
 */
async function claimSend(OcrDocument, paperlessId, { staleMs = SEND_CLAIM_STALE_MS } = {}) {
  const staleCutoff = new Date(Date.now() - staleMs);

  const claimed = await OcrDocument.findOneAndUpdate(
    {
      paperlessId,
      // Not already successfully linked to a KashFlow purchase
      $nor: [{ kashflowPurchaseId: { $ne: null }, lastSendStatus: 201 }],
      // No live in-flight claim (missing, cleared, or stale)
      $or: [
        { kfSendLockedAt: null },
        { kfSendLockedAt: { $exists: false } },
        { kfSendLockedAt: { $lt: staleCutoff } }
      ]
    },
    { $set: { kfSendLockedAt: new Date() } },
    { new: true }
  ).select('_id').lean();

  if (claimed) return { ok: true };

  // Claim failed — diagnose why for a useful message
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('kashflowPurchaseId lastSendStatus kfSendLockedAt')
    .lean();

  if (!doc) {
    return {
      ok: false,
      reason: 'not-found',
      message: `No OCR document found for Paperless id ${paperlessId}.`
    };
  }
  if (doc.kashflowPurchaseId != null && doc.lastSendStatus === 201) {
    return {
      ok: false,
      reason: 'already-linked',
      purchaseId: doc.kashflowPurchaseId,
      message: `This document is already linked to KashFlow purchase #${doc.kashflowPurchaseId}. Unlink it first before re-sending.`
    };
  }
  return {
    ok: false,
    reason: 'in-progress',
    message: 'A send for this document is already in progress — wait for it to finish before retrying.'
  };
}

/**
 * Release a claim (call from a finally path whether the send succeeded or
 * failed). A successful send is still protected afterwards by the
 * already-linked condition in claimSend's filter.
 */
async function releaseSend(OcrDocument, paperlessId) {
  try {
    await OcrDocument.updateOne({ paperlessId }, { $set: { kfSendLockedAt: null } });
  } catch (err) {
    // The stale-claim timeout is the fallback if this fails
    logger.warn(`[kashflowSendClaim] Failed to release send claim for paperlessId=${paperlessId}: ${err.message}`);
  }
}

export default { claimSend, releaseSend, SEND_CLAIM_STALE_MS };
