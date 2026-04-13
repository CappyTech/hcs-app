'use strict';

const mdb = require('./mongooseDatabaseService');

async function getDocumentsOverview({ recentLimit = 15 } = {}) {
  const OcrDocument = mdb.PAPERLESS?.OcrDocument;
  const OcrDocumentIngest = mdb.PAPERLESS?.OcrDocumentIngest;

  if (!OcrDocument) throw new Error('OcrDocument model not loaded');

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totalDocs = await OcrDocument.countDocuments();
  const linkedDocs = await OcrDocument.countDocuments({ kashflowPurchaseId: { $ne: null } });
  const unlinkedDocs = totalDocs - linkedDocs;
  const errorDocs = await OcrDocument.countDocuments({ error: { $ne: null } });

  // ── By last send status ────────────────────────────────────────────────────
  const sentDirect = await OcrDocument.countDocuments({ lastSendMode: 'direct' });
  const sentWebhook = await OcrDocument.countDocuments({ lastSendMode: 'webhook' });
  const neverSent = await OcrDocument.countDocuments({ lastSentAt: null });

  // ── By document type ───────────────────────────────────────────────────────
  const byDocType = await OcrDocument.aggregate([
    { $group: { _id: '$documentType.name', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);

  // ── Recently added (by paperless 'added' date) ─────────────────────────────
  const recentDocs = await OcrDocument.find({})
    .sort({ added: -1 })
    .limit(recentLimit)
    .select('paperlessId title documentType correspondent added fetchedAt lastSentAt kashflowPurchaseNumber error')
    .lean();

  // ── Error documents ────────────────────────────────────────────────────────
  const errorDocsList = await OcrDocument.find({ error: { $ne: null } })
    .sort({ fetchedAt: -1 })
    .limit(10)
    .select('paperlessId title error fetchedAt')
    .lean();

  // ── Orphaned links (linked OcrDocs whose REST purchase is gone/soft-deleted) ──
  let orphanedDocs = 0;
  const Purchase = mdb.REST?.purchase;
  if (Purchase && linkedDocs > 0) {
    const linked = await OcrDocument
      .find({ kashflowPurchaseId: { $ne: null } })
      .select('kashflowPurchaseId')
      .lean();
    const allPurchases = await Purchase
      .find({})
      .select('Id deletedAt DeletedAt')
      .lean();
    const activePurchaseIds = new Set(
      allPurchases
        .filter(p => !p.deletedAt && !p.DeletedAt)
        .map(p => p.Id)
        .filter(id => id != null),
    );
    orphanedDocs = linked.filter(d => !activePurchaseIds.has(d.kashflowPurchaseId)).length;
  }

  // ── Ingest stats ───────────────────────────────────────────────────────────
  let ingestStats = { total: 0, fetched: 0, skipped: 0, error: 0 };
  if (OcrDocumentIngest) {
    const ingestAgg = await OcrDocumentIngest.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    ingestStats.total = 0;
    for (const r of ingestAgg) {
      const s = r._id || 'fetched';
      ingestStats[s] = r.count;
      ingestStats.total += r.count;
    }
  }

  return {
    totalDocs,
    linkedDocs,
    unlinkedDocs,
    orphanedDocs,
    errorDocs,
    sentDirect,
    sentWebhook,
    neverSent,
    byDocType,
    recentDocs,
    errorDocsList,
    ingestStats,
    recentLimit,
  };
}

module.exports = { getDocumentsOverview };
