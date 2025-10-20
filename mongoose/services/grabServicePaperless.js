// services/grabServicepPaperless.js
const crypto = require('crypto');
// Use promise-limit (installed) instead of ESM-only p-limit to avoid CJS interop issues
const promiseLimit = require('promise-limit');
const mdb = require('./mongooseDatabaseService');
const { makeClient } = require('./paperless/paperlessClient');
const logger = require('../../services/loggerService'); // your existing logger

const VERBOSE = process.env.PAPERLESS_VERBOSE === 'true' || process.env.DEBUG;

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
        const contentHash = sha256(ocrText);
        const modified = doc.modified ? new Date(doc.modified) : null;

        // Check ingest tracker
        const ingest = await OcrDocumentIngest.findOne({ paperlessId: doc.id }).lean();
        const unchanged =
          ingest &&
          ingest.lastContentHash === contentHash &&
          ((ingest.lastModified && modified && ingest.lastModified.getTime() === modified.getTime()) ||
           !modified); // if modified is absent, rely on hash only

        if (unchanged) {
          await OcrDocumentIngest.updateOne(
            { paperlessId: doc.id },
            { $set: { status: 'skipped', lastFetchedAt: new Date() } }
          );
          skipped++;
          return;
        }

        // Resolve related entities (best-effort)
        const [correspondent, docType, tagsResolved] = await Promise.all([
          api.getCorrespondent(doc.correspondent).catch(() => null),
          api.getDocumentType(doc.document_type).catch(() => null),
          Promise.all((doc.tags || []).map(id => api.getTag(id).catch(() => null))).then(a => a.filter(Boolean)),
        ]);

        // Upsert into OcrDocument (unique: paperlessId)
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
          fetchedAt: new Date(),
          error: null,
        };

        await OcrDocument.updateOne(
          { paperlessId: doc.id },
          { $set: record },
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
