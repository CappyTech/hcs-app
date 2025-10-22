// services/grabServicepPaperless.js
const crypto = require('crypto');
// Use promise-limit (installed) instead of ESM-only p-limit to avoid CJS interop issues
const promiseLimit = require('promise-limit');
const mdb = require('./mongooseDatabaseService');
const { makeClient } = require('./paperless/paperlessClient');
const logger = require('../../services/loggerService'); // your existing logger

const VERBOSE = process.env.PAPERLESS_VERBOSE === 'true' || process.env.DEBUG;

// Stable stringify: sorts object keys and normalizes dates/arrays for consistent hashing
function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (v) => {
    if (v === null || typeof v !== 'object') {
      if (v instanceof Date) return v.toISOString();
      return v;
    }
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
            api.getCorrespondent(doc.correspondent).catch(() => null),
            api.getDocumentType(doc.document_type).catch(() => null),
            Promise.all((doc.tags || []).map(id => api.getTag(id).catch(() => null))).then(a => a.filter(Boolean)),
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

        if (unchanged) {
          await OcrDocumentIngest.updateOne(
            { paperlessId: doc.id },
            { $set: { status: 'skipped', lastFetchedAt: new Date() } }
          );
          skipped++;
          return;
        }

        // Upsert into OcrDocument (unique: paperlessId)
        const toPersist = { ...record, fetchedAt: new Date(), error: null };

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
        logger.error(`Paperless grab failed for doc ${doc?.id}: ${err.message}`);
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

  logger.info(`Paperless grab complete. processed=${processed} skipped=${skipped} failed=${failed}`);
  return { processed, skipped, failed };
}

module.exports = { grabPaperlessOCR };
