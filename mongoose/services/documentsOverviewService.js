'use strict';

const mdb = require('./mongooseDatabaseService');

async function getDocumentsOverview({ recentLimit = 15 } = {}) {
  const OcrDocument = mdb.PAPERLESS?.OcrDocument;
  const OcrDocumentIngest = mdb.PAPERLESS?.OcrDocumentIngest;

  if (!OcrDocument) throw new Error('OcrDocument model not loaded');

  // ── All counts in a single aggregation pass ───────────────────────────────
  const [facetResult] = await OcrDocument.aggregate([
    { $facet: {
      total:    [{ $count: 'n' }],
      linked:   [{ $match: { kashflowPurchaseId: { $ne: null } } }, { $count: 'n' }],
      error:    [{ $match: { error: { $ne: null } } }, { $count: 'n' }],
      direct:   [{ $match: { lastSendMode: 'direct' } }, { $count: 'n' }],
      webhook:  [{ $match: { lastSendMode: 'webhook' } }, { $count: 'n' }],
      neverSent:[{ $match: { lastSentAt: null } }, { $count: 'n' }],
      // Tagged 'added' in Paperless but no KashFlow purchase number recorded in MongoDB
      addedNoKf: [
        { $match: {
          kashflowPurchaseNumber: null,
          'tags.name': { $regex: /^added$/i },
        }},
        { $count: 'n' },
      ],
      // Drift: MongoDB kashflowPurchaseId disagrees with stored Paperless custom field value
      drifted: [
        { $addFields: {
          _cfKfId: {
            $let: {
              vars: {
                found: { $arrayElemAt: [
                  { $filter: {
                    input: { $ifNull: ['$customFields', []] },
                    cond:  { $eq: [
                      { $toLower: { $ifNull: ['$$this.fieldName', ''] } },
                      'kashflow purchase id'
                    ]},
                  }},
                  0,
                ]},
              },
              in: { $ifNull: ['$$found.value', null] },
            },
          },
        }},
        { $match: { $or: [
          // MongoDB says linked but Paperless field is absent/empty
          { kashflowPurchaseId: { $ne: null }, $or: [{ _cfKfId: null }, { _cfKfId: '' }] },
          // MongoDB says unlinked but Paperless field is set
          { kashflowPurchaseId: null, _cfKfId: { $nin: [null, ''] } },
        ]}},
        { $count: 'n' },
      ],
    }},
  ]);
  const totalDocs    = facetResult?.total?.[0]?.n    ?? 0;
  const linkedDocs   = facetResult?.linked?.[0]?.n   ?? 0;
  const unlinkedDocs = totalDocs - linkedDocs;
  const errorDocs    = facetResult?.error?.[0]?.n    ?? 0;
  const sentDirect   = facetResult?.direct?.[0]?.n   ?? 0;
  const sentWebhook  = facetResult?.webhook?.[0]?.n  ?? 0;
  const neverSent    = facetResult?.neverSent?.[0]?.n ?? 0;
  const driftedDocs      = facetResult?.drifted?.[0]?.n  ?? 0;
  const addedNoKfNumber = facetResult?.addedNoKf?.[0]?.n ?? 0;

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

  // ── Orphaned links: query only the referenced purchases (not the full collection) ──
  let orphanedDocs = 0;
  const Purchase = mdb.REST?.purchase;
  if (Purchase && linkedDocs > 0) {
    const linked = await OcrDocument
      .find({ kashflowPurchaseId: { $ne: null } })
      .select('kashflowPurchaseId')
      .lean();
    const linkedIds = [...new Set(linked.map(d => d.kashflowPurchaseId).filter(id => id != null))];
    const activePurchases = await Purchase
      .find({ Id: { $in: linkedIds }, deletedAt: null, DeletedAt: null })
      .select('Id')
      .lean();
    const activePurchaseIds = new Set(activePurchases.map(p => p.Id));
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
    driftedDocs,
    errorDocs,
    addedNoKfNumber,
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
