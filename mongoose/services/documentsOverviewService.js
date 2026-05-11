'use strict';

const mdb = require('./mongooseDatabaseService');

const DETAIL_LIMIT = 100;

// Shared aggregation stages to extract the cached Paperless CF value for 'kashflow purchase id'
const CF_KF_ID_ADD_FIELD = {
  $addFields: {
    _cfKfId: {
      $let: {
        vars: {
          found: { $arrayElemAt: [
            { $filter: {
              input: { $ifNull: ['$customFields', []] },
              cond: { $eq: [
                { $toLower: { $ifNull: ['$$this.fieldName', ''] } },
                'kashflow purchase id',
              ]},
            }},
            0,
          ]},
        },
        in: { $ifNull: ['$$found.value', null] },
      },
    },
  },
};

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
      sentButUnlinked: [
        { $match: { kashflowPurchaseId: null, lastSentAt: { $ne: null } } },
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
  const driftedDocs  = facetResult?.drifted?.[0]?.n  ?? 0;
  const sentButUnlinked = facetResult?.sentButUnlinked?.[0]?.n ?? 0;

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
    .limit(DETAIL_LIMIT)
    .select('paperlessId title documentType error fetchedAt')
    .lean();

  // ── Drifted docs detail list ───────────────────────────────────────────────
  const driftedDocsList = await OcrDocument.aggregate([
    CF_KF_ID_ADD_FIELD,
    { $match: { $or: [
      { kashflowPurchaseId: { $ne: null }, $or: [{ _cfKfId: null }, { _cfKfId: '' }] },
      { kashflowPurchaseId: null, _cfKfId: { $nin: [null, ''] } },
    ]}},
    { $project: { paperlessId: 1, title: 1, documentType: 1, kashflowPurchaseId: 1, kashflowPurchaseNumber: 1, kashflowPermalink: 1, _cfKfId: 1 } },
    { $sort: { paperlessId: -1 } },
    { $limit: DETAIL_LIMIT },
  ]);

  // ── Never sent list ────────────────────────────────────────────────────────
  const neverSentList = await OcrDocument.find({ lastSentAt: null })
    .sort({ added: -1 })
    .limit(DETAIL_LIMIT)
    .select('paperlessId title documentType added')
    .lean();

  // ── Unlinked list (no KashFlow purchase ID, includes never sent) ───────────
  const unlinkedDocsList = await OcrDocument.find({ kashflowPurchaseId: null })
    .sort({ added: -1 })
    .limit(DETAIL_LIMIT)
    .select('paperlessId title documentType added lastSentAt lastSendMode lastSendStatus')
    .lean();

  // ── Ingest stats + error list ──────────────────────────────────────────────
  let ingestStats = { total: 0, fetched: 0, skipped: 0, error: 0 };
  let ingestErrorsList = [];
  if (OcrDocumentIngest) {
    const ingestAgg = await OcrDocumentIngest.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    for (const r of ingestAgg) {
      const s = r._id || 'fetched';
      ingestStats[s] = r.count;
      ingestStats.total += r.count;
    }
    if (ingestStats.error > 0) {
      ingestErrorsList = await OcrDocumentIngest.find({ status: 'error' })
        .sort({ lastFetchedAt: -1 })
        .limit(DETAIL_LIMIT)
        .select('paperlessId error lastFetchedAt')
        .lean();
    }
  }

  // ── Orphaned links: query only the referenced purchases (not the full collection) ──
  let orphanedDocs = 0;
  let staleLinkedList = [];
  const Purchase = mdb.REST?.purchase;
  if (Purchase && linkedDocs > 0) {
    const linked = await OcrDocument
      .find({ kashflowPurchaseId: { $ne: null } })
      .select('paperlessId title documentType kashflowPurchaseId kashflowPurchaseNumber kashflowPermalink lastSentAt')
      .lean();
    const linkedIds = [...new Set(linked.map(d => d.kashflowPurchaseId).filter(id => id != null))];
    const activePurchases = await Purchase
      .find({ Id: { $in: linkedIds }, deletedAt: null, DeletedAt: null })
      .select('Id')
      .lean();
    const activePurchaseIds = new Set(activePurchases.map(p => p.Id));
    const stale = linked.filter(d => !activePurchaseIds.has(d.kashflowPurchaseId));
    orphanedDocs = stale.length;
    staleLinkedList = stale.slice(0, DETAIL_LIMIT);
  }

  return {
    totalDocs,
    linkedDocs,
    unlinkedDocs,
    orphanedDocs,
    driftedDocs,
    sentButUnlinked,
    errorDocs,
    sentDirect,
    sentWebhook,
    neverSent,
    byDocType,
    recentDocs,
    errorDocsList,
    driftedDocsList,
    neverSentList,
    unlinkedDocsList,
    ingestStats,
    ingestErrorsList,
    staleLinkedList,
    recentLimit,
  };
}

module.exports = { getDocumentsOverview };
