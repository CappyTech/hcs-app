// services/grabServicepPaperless.js
const crypto = require('crypto');
// Use promise-limit (installed) instead of ESM-only p-limit to avoid CJS interop issues
const promiseLimit = require('promise-limit');
const mdb = require('./mongooseDatabaseService');
const { makeClient } = require('./paperless/paperlessClient');
const { updatePaperlessWithKashFlowInfo } = require('./paperless/paperlessUpdateService');
const logger = require('../../services/loggerService'); // your existing logger

const VERBOSE = process.env.PAPERLESS_VERBOSE === 'true' || process.env.DEBUG;

// Module-level guard: prevents concurrent grab runs
let grabRunning = false;
function isGrabRunning() { return grabRunning; }

// Stable stringify: sorts object keys and normalizes dates/arrays for consistent hashing
function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (v) => {
    if (v instanceof Date) return v.toISOString();
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return undefined; // break cycles
    seen.add(v);
    if (Array.isArray(v)) {
      return v.map(normalize);
    }
    const keys = Object.keys(v).sort();
    const obj = {};
    for (const k of keys) obj[k] = normalize(v[k]);
    return obj;
  };
  return JSON.stringify(normalize(value));
}

function sha256(str) {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

// Options: { since, query, pageSize, concurrency }
async function grabPaperlessOCR(options = {}) {
  if (grabRunning) {
    logger.warn('[paperless] Grab already in progress — skipping concurrent run.');
    return { processed: 0, skipped: 0, failed: 0 };
  }
  grabRunning = true;
  try {
  const {
    since = process.env.PAPERLESS_SINCE || null,     // ISO string or null
    query = process.env.PAPERLESS_QUERY || null,     // Paperless search string
    pageSize = parseInt(process.env.PAPERLESS_PAGE_SIZE || '50', 10),
    concurrency = parseInt(process.env.PAPERLESS_CONCURRENCY || '5', 10),
  } = options;

  if (VERBOSE) {
    logger.info(`[paperless] Starting grab with filters: since=${since || 'none'}, query=${query || 'none'}, pageSize=${pageSize}, concurrency=${concurrency}`);
  }

  await mdb.connect();
  const api = makeClient();

  // Per-run memoization — each unique correspondent/type/tag fetched at most once per grab
  const corrCache = new Map();
  const typeCache = new Map();
  const tagCache  = new Map();
  const getCorrCached = async (id) => {
    if (!id) return null;
    if (corrCache.has(id)) return corrCache.get(id);
    const val = await api.getCorrespondent(id).catch(() => null);
    corrCache.set(id, val);
    return val;
  };
  const getTypeCached = async (id) => {
    if (!id) return null;
    if (typeCache.has(id)) return typeCache.get(id);
    const val = await api.getDocumentType(id).catch(() => null);
    typeCache.set(id, val);
    return val;
  };
  const getTagCached = async (id) => {
    if (!id) return null;
    if (tagCache.has(id)) return tagCache.get(id);
    const val = await api.getTag(id).catch(() => null);
    tagCache.set(id, val);
    return val;
  };

  // Prefetch all custom field definitions (id -> name) to ensure we can label values without per-doc expands
  async function fetchAllCustomFieldsMap() {
    const map = new Map();
    try {
      let page = 1;
      const pageSize = 100;
      while (true) {
        const data = await api.listCustomFields({ page, pageSize, ordering: 'name' });
        const results = Array.isArray(data?.results) ? data.results : [];
        for (const r of results) {
          if (r && typeof r.id === 'number') {
            map.set(r.id, { id: r.id, name: r.name, data_type: r.data_type });
          }
        }
        if (!data?.next || results.length === 0) break;
        page += 1;
      }
    } catch (e) {
      logger.warn(`[paperless] Unable to prefetch custom fields: ${e.message}`);
    }
    return map;
  }

  const customFieldMap = await fetchAllCustomFieldsMap();

  const { OcrDocument, OcrDocumentIngest } = mdb.PAPERLESS;
  if (!OcrDocument || !OcrDocumentIngest) {
    throw new Error('PAPERLESS models not loaded. Ensure OcrDocument and OcrDocumentIngest exist.');
  }

  let page = 1;
  const limit = promiseLimit(concurrency);
  let processed = 0, skipped = 0, failed = 0;

  while (true) {
    const pageData = await api.listDocuments({ page, pageSize, query, modified__gte: since });

    const results = pageData.results || [];
    if (VERBOSE) {
      const nextFlag = pageData && typeof pageData.next !== 'undefined' ? Boolean(pageData.next) : false;
      const total = typeof pageData.count === 'number' ? pageData.count : 'unknown';
      logger.info(`[paperless] page=${page} results=${results.length} total=${total} next=${nextFlag}`);
    }
    if (results.length === 0) break;

    const tasks = results.map(doc => limit(async () => {
      try {
        const ocrText = doc.content || '';
        const modified = doc.modified ? new Date(doc.modified) : null;

        // Resolve related entities and custom fields BEFORE skip decision so any change triggers processing
          const [correspondent, docType, tagsResolved, customFields] = await (async () => {
          const [corr, dtype, tags] = await Promise.all([
            getCorrCached(doc.correspondent),
            getTypeCached(doc.document_type),
            Promise.all((doc.tags || []).map(id => getTagCached(id))).then(a => a.filter(Boolean)),
          ]);

          // Custom fields: prefer presence on list payload; else fetch full document (expand)
          let cf = [];
          const rawCf = doc.custom_fields || doc.customFields || null;
          const mapCF = (entry) => {
            // Paperless custom field value may have shape { id, field: { id, name }, value }
            // or { field: <id>, value } or legacy { name, value }
            const fieldObj = entry && typeof entry.field === 'object' ? entry.field : null;
            const fieldId = fieldObj ? Number(fieldObj.id) : (
              typeof entry.field === 'number' ? Number(entry.field) : Number(entry.fieldId || entry.field_id || entry.id)
            );
            let fieldName = fieldObj && fieldObj.name
              ? String(fieldObj.name)
              : String(entry.name || entry.fieldName || entry.field_name || '');
            // If name still missing but we have an id, try lookup from prefetched map
            if ((!fieldName || fieldName === '') && Number.isFinite(fieldId) && customFieldMap && customFieldMap.size) {
              const meta = customFieldMap.get(Number(fieldId));
              if (meta && meta.name) fieldName = String(meta.name);
            }
            const value = (typeof entry.value !== 'undefined') ? entry.value : (entry.val ?? null);
            return {
              fieldId: Number.isFinite(fieldId) ? fieldId : undefined,
              fieldName: fieldName || undefined,
              value
            };
          };

          const needsName = (arr) => !arr.some(x => x.fieldName);

          if (Array.isArray(rawCf)) {
            cf = rawCf.map(mapCF).filter(x => (x.fieldId || x.fieldName || typeof x.value !== 'undefined'));
            // If names are still missing and our map couldn't fill them, refetch expanded once
            if (needsName(cf)) {
              try {
                const full = await api.getDocument(doc.id, { expand: ['custom_fields', 'custom_fields__field'] });
                const fullCf = full && (full.custom_fields || full.customFields);
                if (Array.isArray(fullCf)) {
                  cf = fullCf.map(mapCF).filter(x => (x.fieldId || x.fieldName || typeof x.value !== 'undefined'));
                }
              } catch (_) { /* ignore */ }
            }
          } else {
            try {
              const full = await api.getDocument(doc.id, { expand: ['custom_fields', 'custom_fields__field'] });
              const fullCf = full && (full.custom_fields || full.customFields);
              if (Array.isArray(fullCf)) {
                cf = fullCf.map(mapCF).filter(x => (x.fieldId || x.fieldName || typeof x.value !== 'undefined'));
              }
            } catch (_) { /* ignore */ }
          }

          return [corr, dtype, tags, cf];
        })();

        // Build the record we intend to persist (excluding transient fields)
        const record = {
          paperlessId: doc.id,
          title: doc.title || null,
          ocrText,
          correspondent: correspondent ? { id: correspondent.id, name: correspondent.name } : undefined,
          documentType: docType ? { id: docType.id, name: docType.name } : undefined,
          tags: (tagsResolved || []).map(t => ({ id: t.id, name: t.name, slug: t.slug })),
          created: doc.created ? new Date(doc.created) : undefined,
          added: doc.added ? new Date(doc.added) : undefined,
          modified,
          archiveSerialNumber: doc.archive_serial_number || null,
          originalFileName: doc.original_file_name || null,
          archivedFileName: doc.archived_file_name || null,
          customFields,
        };

        // Normalize arrays for deterministic hashing
        const normForHash = {
          ...record,
          // sort tags by id then name
          tags: (record.tags || []).slice().sort((a, b) => (a.id - b.id) || String(a.name).localeCompare(String(b.name))),
          // sort custom fields by fieldId then fieldName
          customFields: (record.customFields || []).slice().sort((a, b) => (Number(a.fieldId||0) - Number(b.fieldId||0)) || String(a.fieldName||'').localeCompare(String(b.fieldName||''))),
        };
        const contentHash = sha256(stableStringify(normForHash));

        // Check ingest tracker with composite hash across all persisted fields
        const ingest = await OcrDocumentIngest.findOne({ paperlessId: doc.id }).lean();
        const unchanged = ingest && ingest.lastContentHash === contentHash;

        // Pre-resolve KashFlow purchase number from custom fields — used in both branches.
        // Covers two cases:
        //   1. Hash changed: user just entered the number in Paperless → write it to MongoDB.
        //   2. Hash unchanged: number was already there when first ingested but backfill hadn't
        //      run yet → quietly patch without bumping the hash or status.
        const _cfKfEntry = customFields.find(
          (cf) => /kashflow\s*purchase\s*number/i.test(cf.fieldName || '')
        );
        const _cfKfNum = _cfKfEntry?.value != null ? parseInt(String(_cfKfEntry.value), 10) : NaN;
        const _hasCfKfNum = Number.isFinite(_cfKfNum) && _cfKfNum > 0;

        // Whether the Paperless doc already carries the KashFlow purchase ID as a custom field
        const _cfKfIdIncoming = customFields.some(cf => /kashflow\s*purchase\s*id/i.test(cf.fieldName || ''));

        // Helper: resolve linkage fields from REST when Paperless has a purchase number we haven't stored.
        const resolveCfKfBackfill = async () => {
          if (!_hasCfKfNum || !mdb.REST?.purchase) return {};
          try {
            const existing = await OcrDocument.findOne({ paperlessId: doc.id })
              .select('kashflowPurchaseNumber')
              .lean();
            if (existing?.kashflowPurchaseNumber) return {}; // already linked — nothing to do
            const restPurchase = await mdb.REST.purchase
              .findOne({ Number: _cfKfNum })
              .select('Number Id Permalink')
              .lean();
            if (!restPurchase) {
              // Store the number anyway — it IS recorded in Paperless. The doc then shows
              // as "has KF# (no ID) — resolvable" instead of falsely "missing", and
              // resolve-numbers can link it once the purchase appears in REST.
              logger.warn(`[paperless] CF "KashFlow Purchase Number"=${_cfKfNum} not found in REST for paperlessId=${doc.id} — storing number without ID`);
              return { kashflowPurchaseNumber: _cfKfNum };
            }
            const patch = { kashflowPurchaseNumber: restPurchase.Number ?? _cfKfNum };
            if (typeof restPurchase.Id === 'number') patch.kashflowPurchaseId = restPurchase.Id;
            if (restPurchase.Permalink) patch.kashflowPermalink = restPurchase.Permalink;
            logger.info(`[paperless] Backfilled KashFlow linkage for paperlessId=${doc.id} (purchase #${_cfKfNum})`);
            return patch;
          } catch (err) {
            logger.warn(`[paperless] KashFlow backfill failed for paperlessId=${doc.id}: ${err.message}`);
            return {};
          }
        };

        if (unchanged) {
          // Silently patch linkage if the CF has a number we haven't captured yet
          if (_hasCfKfNum) {
            const patch = await resolveCfKfBackfill();
            if (Object.keys(patch).length > 0) {
              await OcrDocument.updateOne({ paperlessId: doc.id }, { $set: patch });
            }
          }
          await OcrDocumentIngest.updateOne(
            { paperlessId: doc.id },
            { $set: { status: 'skipped', lastFetchedAt: new Date() } }
          );
          skipped++;
          return;
        }

        // Upsert into OcrDocument (unique: paperlessId)
        const kfBackfill = await resolveCfKfBackfill();

        // Drift guard: if Paperless lost the KF ID CF but MongoDB already has the ID, re-inject
        // the CF so the $set doesn't create drift. Also fire a background write-back to Paperless.
        let finalKfId = kfBackfill.kashflowPurchaseId ?? null;
        if (finalKfId == null && !_cfKfIdIncoming) {
          const _ex = await OcrDocument.findOne({ paperlessId: doc.id })
            .select('kashflowPurchaseId kashflowPurchaseNumber kashflowPermalink lastSendStatus customFields')
            .lean();
          finalKfId = _ex?.kashflowPurchaseId ?? null;
          if (finalKfId != null) {
            setImmediate(() => updatePaperlessWithKashFlowInfo(
              doc.id,
              { Id: _ex.kashflowPurchaseId, Number: _ex.kashflowPurchaseNumber, Permalink: _ex.kashflowPermalink },
              _ex.lastSendStatus,
              { existingCf: _ex.customFields || [] },
            ).catch(e => logger.warn(`[grabServicePaperless] CF write-back failed for paperlessId=${doc.id}: ${e.message}`)));
          }
        }
        const customFieldsToSave = (finalKfId != null && !_cfKfIdIncoming)
          ? [...(record.customFields || []), { fieldName: 'KashFlow Purchase Id', value: String(finalKfId) }]
          : record.customFields;
        const toPersist = { ...record, customFields: customFieldsToSave, ...kfBackfill, fetchedAt: new Date(), error: null };

        await OcrDocument.updateOne(
          { paperlessId: doc.id },
          { $set: toPersist },
          { upsert: true }
        );

        // Update ingest tracker
        await OcrDocumentIngest.updateOne(
          { paperlessId: doc.id },
          {
            $set: {
              paperlessId: doc.id,
              lastModified: modified || null,
              lastContentHash: contentHash,
              lastFetchedAt: new Date(),
              status: 'fetched',
              error: null,
            },
          },
          { upsert: true }
        );

        processed++;
      } catch (err) {
        failed++;
        logger.error(`[grabServicePaperless] Failed for doc ${doc?.id}: ${err.message}`, { stack: err.stack });
        // Persist error on ingest tracker (so we can reprocess later)
        await mdb.PAPERLESS.OcrDocumentIngest.updateOne(
          { paperlessId: doc?.id },
          {
            $set: {
              paperlessId: doc?.id,
              lastFetchedAt: new Date(),
              status: 'error',
              error: String(err?.message || err),
            },
          },
          { upsert: true }
        );
      }
    }));

    await Promise.allSettled(tasks);

    if (!pageData.next) break;
    page += 1;
  }

  logger.info(`[grabServicePaperless] Complete. processed=${processed} skipped=${skipped} failed=${failed}`);
  return { processed, skipped, failed };
  } finally {
    grabRunning = false;
  }
}

// Ingest a single Paperless document by ID and upsert into Mongo
async function ingestOnePaperlessDoc(paperlessId) {
  if (!Number.isFinite(Number(paperlessId))) throw new Error('paperlessId must be a number');
  await mdb.connect();
  const api = makeClient();
  const { OcrDocument, OcrDocumentIngest } = mdb.PAPERLESS;
  if (!OcrDocument || !OcrDocumentIngest) {
    throw new Error('PAPERLESS models not loaded. Ensure OcrDocument and OcrDocumentIngest exist.');
  }

  // Fetch full document with expansions so we can resolve custom fields cleanly
  let doc;
  try {
    doc = await api.getDocument(Number(paperlessId), { expand: ['custom_fields', 'custom_fields__field'] });
  } catch (fetchErr) {
    const is404 = fetchErr?.response?.status === 404 || /not found/i.test(fetchErr?.message || '');
    const errMsg = is404
      ? `Document #${paperlessId} not found in Paperless (404) — it may have been deleted`
      : `Failed to fetch document #${paperlessId} from Paperless: ${fetchErr.message}`;
    logger.warn(`[paperless] ${errMsg}`);
    // Persist error state so the ingest tracker reflects the failure
    await OcrDocumentIngest.updateOne(
      { paperlessId: Number(paperlessId) },
      { $set: { paperlessId: Number(paperlessId), lastFetchedAt: new Date(), status: 'error', error: errMsg } },
      { upsert: true }
    );
    if (is404) {
      await OcrDocument.updateOne(
        { paperlessId: Number(paperlessId) },
        { $set: { error: errMsg, fetchedAt: new Date() } }
      );
    }
    const err = new Error(errMsg);
    err.status = is404 ? 404 : 502;
    throw err;
  }
  if (!doc || typeof doc.id !== 'number') throw new Error('Paperless document not found');

  const [correspondent, docType, tagsResolved] = await Promise.all([
    api.getCorrespondent(doc.correspondent).catch(() => null),
    api.getDocumentType(doc.document_type).catch(() => null),
    Promise.all((doc.tags || []).map((id) => api.getTag(id).catch(() => null))).then((a) => a.filter(Boolean)),
  ]);

  const mapCF = (entry) => {
    const fieldObj = entry && typeof entry.field === 'object' ? entry.field : null;
    const fieldId = fieldObj ? Number(fieldObj.id) : (typeof entry.field === 'number' ? Number(entry.field) : Number(entry.fieldId || entry.field_id || entry.id));
    const fieldName = fieldObj && fieldObj.name ? String(fieldObj.name) : String(entry.name || entry.fieldName || entry.field_name || '');
    const value = typeof entry.value !== 'undefined' ? entry.value : entry.val ?? null;
    return { fieldId: Number.isFinite(fieldId) ? fieldId : undefined, fieldName: fieldName || undefined, value };
  };
  const customFieldsRaw = doc.custom_fields || doc.customFields || [];
  const customFields = Array.isArray(customFieldsRaw) ? customFieldsRaw.map(mapCF).filter((x) => (x.fieldId || x.fieldName || typeof x.value !== 'undefined')) : [];

  const modified = doc.modified ? new Date(doc.modified) : null;
  const record = {
    paperlessId: doc.id,
    title: doc.title || null,
    ocrText: doc.content || '',
    correspondent: correspondent ? { id: correspondent.id, name: correspondent.name } : undefined,
    documentType: docType ? { id: docType.id, name: docType.name } : undefined,
    tags: (tagsResolved || []).map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
    created: doc.created ? new Date(doc.created) : undefined,
    added: doc.added ? new Date(doc.added) : undefined,
    modified,
    archiveSerialNumber: doc.archive_serial_number || null,
    originalFileName: doc.original_file_name || null,
    archivedFileName: doc.archived_file_name || null,
    customFields,
  };

  const normForHash = {
    ...record,
    tags: (record.tags || []).slice().sort((a, b) => (a.id - b.id) || String(a.name).localeCompare(String(b.name))),
    customFields: (record.customFields || []).slice().sort((a, b) => (Number(a.fieldId || 0) - Number(b.fieldId || 0)) || String(a.fieldName || '').localeCompare(String(b.fieldName || ''))),
  };
  const contentHash = sha256(stableStringify(normForHash));

  // Backfill KashFlow linkage from custom fields when the dedicated fields are not yet set.
  // If the Paperless document has "KashFlow Purchase Number" as a custom field but the DB
  // record has no kashflowPurchaseNumber, look the purchase up in the REST collection and
  // populate all linkage fields so the document appears correctly linked without a re-send.
  const kfBackfill = {};
  let _ingestExistingLink = null;
  try {
    _ingestExistingLink = await OcrDocument.findOne({ paperlessId: doc.id })
      .select('kashflowPurchaseNumber kashflowPurchaseId kashflowPermalink lastSendStatus customFields')
      .lean();
    if (!_ingestExistingLink?.kashflowPurchaseNumber) {
      const cfNumber = customFields.find(
        (cf) => /kashflow\s*purchase\s*number/i.test(cf.fieldName || '')
      );
      const rawNum = cfNumber?.value;
      const cfPurchaseNum = rawNum != null ? parseInt(String(rawNum), 10) : NaN;
      if (Number.isFinite(cfPurchaseNum) && cfPurchaseNum > 0 && mdb.REST?.purchase) {
        const restPurchase = await mdb.REST.purchase
          .findOne({ Number: cfPurchaseNum })
          .select('Number Id Permalink')
          .lean();
        if (restPurchase) {
          kfBackfill.kashflowPurchaseNumber = restPurchase.Number ?? cfPurchaseNum;
          if (typeof restPurchase.Id === 'number') kfBackfill.kashflowPurchaseId = restPurchase.Id;
          if (restPurchase.Permalink) kfBackfill.kashflowPermalink = restPurchase.Permalink;
          logger.info(
            `[paperless] Backfilled KashFlow linkage for paperlessId=${doc.id} from custom field (purchase #${cfPurchaseNum})`
          );
        } else {
          // Store the number anyway — it IS recorded in Paperless. The doc then shows
          // as "has KF# (no ID) — resolvable" instead of falsely "missing".
          kfBackfill.kashflowPurchaseNumber = cfPurchaseNum;
          logger.warn(
            `[paperless] Custom field "KashFlow Purchase Number"=${cfPurchaseNum} not found in REST purchases for paperlessId=${doc.id} — storing number without ID`
          );
        }
      }
    }
  } catch (backfillErr) {
    logger.warn(`[paperless] KashFlow backfill failed for paperlessId=${doc.id}: ${backfillErr.message}`);
  }

  // Drift guard: same logic as the grab path — if Paperless lost the CF but MongoDB has the ID,
  // inject the CF entry and fire a background write-back so Paperless catches up.
  const _cfKfIdIncoming = customFields.some(cf => /kashflow\s*purchase\s*id/i.test(cf.fieldName || ''));
  const finalKfId = kfBackfill.kashflowPurchaseId ?? (_ingestExistingLink?.kashflowPurchaseId ?? null);
  const customFieldsToSave = (finalKfId != null && !_cfKfIdIncoming)
    ? [...customFields, { fieldName: 'KashFlow Purchase Id', value: String(finalKfId) }]
    : customFields;
  if (finalKfId != null && !_cfKfIdIncoming) {
    if (!kfBackfill.kashflowPurchaseId) kfBackfill.kashflowPurchaseId = finalKfId;
    setImmediate(() => updatePaperlessWithKashFlowInfo(
      doc.id,
      { Id: finalKfId, Number: kfBackfill.kashflowPurchaseNumber ?? _ingestExistingLink?.kashflowPurchaseNumber ?? null, Permalink: kfBackfill.kashflowPermalink ?? _ingestExistingLink?.kashflowPermalink ?? null },
      _ingestExistingLink?.lastSendStatus ?? null,
      { existingCf: customFields },
    ).catch(e => logger.warn(`[paperless] CF write-back failed for paperlessId=${doc.id}: ${e.message}`)));
  }

  // Upsert document and tracker
  await OcrDocument.updateOne(
    { paperlessId: doc.id },
    { $set: { ...record, customFields: customFieldsToSave, ...kfBackfill, fetchedAt: new Date(), error: null } },
    { upsert: true }
  );
  await OcrDocumentIngest.updateOne(
    { paperlessId: doc.id },
    {
      $set: {
        paperlessId: doc.id,
        lastModified: modified || null,
        lastContentHash: contentHash,
        lastFetchedAt: new Date(),
        status: 'fetched',
        error: null,
      },
    },
    { upsert: true }
  );

  if (VERBOSE) logger.info(`[paperless] Ingested single doc paperlessId=${doc.id}`);
  return { paperlessId: doc.id, status: 'fetched' };
}

module.exports = { grabPaperlessOCR, ingestOnePaperlessDoc, isGrabRunning };
