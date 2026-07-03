'use strict';

const mdb = require('./mongooseDatabaseService');

const DETAIL_LIMIT = 100;

// Documents that are never sent to KashFlow — statements, subcontractor docs,
// credit notes and docs tagged "original/multiple invoice one pdf" (originals kept
// for reference whose invoices were entered separately) — are excluded from the
// unlinked / never-sent / missing-link panels so those lists only show purchases
// that actually need action.
// Note: uses `tags: { $not: { $elemMatch } }` rather than a 'tags.name' key so it
// can coexist with facets that also match on 'tags.name' (e.g. addedNoKf).
const NOT_FOR_KASHFLOW_TAGS = [
  /original\/multiple invoice one pdf/i, // reference originals; invoices entered separately
  /credit\/refund/i,                     // credit notes (automatic tag; title regex kept as fallback)
];
const KF_ELIGIBLE_MATCH = {
  'documentType.name': { $regex: /^purchase$/i },
  title: { $not: /credit/i },
  tags: { $not: { $elemMatch: { name: { $in: NOT_FOR_KASHFLOW_TAGS } } } },
};

// "manually added to kashflow" docs are already in KashFlow (entered by hand) so the app
// will never send them — exclude from Never Sent only; they stay in Unlinked so
// Match References / Resolve Numbers can still attach them to their purchase.
const NEVER_SENT_ELIGIBLE_MATCH = {
  ...KF_ELIGIBLE_MATCH,
  tags: { $not: { $elemMatch: { name: { $in: [...NOT_FOR_KASHFLOW_TAGS, /manually added to kashflow/i] } } } },
};

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
      // Same, restricted to KF-eligible docs (drives the tile + panel)
      neverSentEligible: [
        { $match: { lastSentAt: null, ...NEVER_SENT_ELIGIBLE_MATCH } },
        { $count: 'n' },
      ],
      // Unlinked, restricted to KF-eligible docs (drives the tile + panel)
      unlinkedEligible: [
        { $match: { kashflowPurchaseId: null, ...KF_ELIGIBLE_MATCH } },
        { $count: 'n' },
      ],
      // Tagged 'added' in Paperless but no KashFlow purchase number recorded in MongoDB
      addedNoKf: [
        { $match: {
          kashflowPurchaseNumber: null,
          'tags.name': { $regex: /^added$/i },
          ...KF_ELIGIBLE_MATCH,
        }},
        { $count: 'n' },
      ],
      sentButUnlinked: [
        { $match: { kashflowPurchaseId: null, lastSentAt: { $ne: null } } },
        { $count: 'n' },
      ],
      // Unlinked but have a KashFlow purchase number — can be auto-resolved via number→ID lookup
      hasNumberNoId: [
        { $match: { kashflowPurchaseId: null, kashflowPurchaseNumber: { $ne: null } } },
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
  const unlinkedAll  = totalDocs - linkedDocs;
  const unlinkedDocs = facetResult?.unlinkedEligible?.[0]?.n ?? 0;
  const unlinkedExcluded = unlinkedAll - unlinkedDocs;
  const errorDocs    = facetResult?.error?.[0]?.n    ?? 0;
  const sentDirect   = facetResult?.direct?.[0]?.n   ?? 0;
  const sentWebhook  = facetResult?.webhook?.[0]?.n  ?? 0;
  const neverSent       = facetResult?.neverSent?.[0]?.n        ?? 0;
  const neverSentEligible = facetResult?.neverSentEligible?.[0]?.n ?? 0;
  const neverSentExcluded = neverSent - neverSentEligible;
  const driftedDocs     = facetResult?.drifted?.[0]?.n          ?? 0;
  const addedNoKfNumber = facetResult?.addedNoKf?.[0]?.n        ?? 0;
  const sentButUnlinked = facetResult?.sentButUnlinked?.[0]?.n  ?? 0;
  const hasNumberNoId   = facetResult?.hasNumberNoId?.[0]?.n    ?? 0;

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

  // ── Never sent list (KF-eligible docs only) ───────────────────────────────
  const neverSentList = await OcrDocument.find({ lastSentAt: null, ...NEVER_SENT_ELIGIBLE_MATCH })
    .sort({ added: -1 })
    .limit(DETAIL_LIMIT)
    .select('paperlessId title documentType added')
    .lean();

  // ── Unlinked list (no KashFlow purchase ID, includes never sent; KF-eligible only) ──
  const unlinkedDocsList = await OcrDocument.find({ kashflowPurchaseId: null, ...KF_ELIGIBLE_MATCH })
    .sort({ added: -1 })
    .limit(DETAIL_LIMIT)
    .select('paperlessId title documentType added lastSentAt lastSendMode lastSendStatus kashflowPurchaseNumber')
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

  // ── Possible re-uploads: error ingest records whose hash matches a live document ──
  // Step 1: collect hashes of error records that have a hash
  // Step 2: find non-error records sharing any of those hashes
  let possibleReuploadCount = 0;
  let possibleReuploadList = [];
  if (OcrDocumentIngest && ingestStats.error > 0) {
    const errorHashes = await OcrDocumentIngest.find({ status: 'error', lastContentHash: { $ne: null } })
      .select('paperlessId lastContentHash')
      .lean();
    const hashSet = [...new Set(errorHashes.map(r => r.lastContentHash))];
    if (hashSet.length > 0) {
      const liveMatches = await OcrDocumentIngest.find({
        lastContentHash: { $in: hashSet },
        status: { $ne: 'error' },
      }).select('paperlessId lastContentHash').lean();
      if (liveMatches.length > 0) {
        const liveHashMap = new Map(liveMatches.map(r => [r.lastContentHash, r.paperlessId]));
        const pairs = errorHashes
          .filter(r => liveHashMap.has(r.lastContentHash))
          .map(r => ({ deletedId: r.paperlessId, survivingId: liveHashMap.get(r.lastContentHash) }));
        possibleReuploadCount = pairs.length;
        // Enrich with titles from OcrDocument
        const allIds = [...new Set(pairs.flatMap(p => [p.deletedId, p.survivingId]))];
        const docMap = new Map(
          (await OcrDocument.find({ paperlessId: { $in: allIds } })
            .select('paperlessId title documentType')
            .lean()
          ).map(d => [d.paperlessId, d])
        );
        possibleReuploadList = pairs.slice(0, DETAIL_LIMIT).map(p => ({
          deletedId: p.deletedId,
          survivingId: p.survivingId,
          deletedDoc: docMap.get(p.deletedId) || null,
          survivingDoc: docMap.get(p.survivingId) || null,
        }));
      }
    }
  }

  return {
    totalDocs,
    linkedDocs,
    unlinkedDocs,
    unlinkedExcluded,
    neverSentEligible,
    neverSentExcluded,
    orphanedDocs,
    driftedDocs,
    sentButUnlinked,
    hasNumberNoId,
    errorDocs,
    addedNoKfNumber,
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
    possibleReuploadCount,
    possibleReuploadList,
    recentLimit,
  };
}

module.exports = { getDocumentsOverview };
