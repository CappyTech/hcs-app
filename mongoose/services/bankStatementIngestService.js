import crypto from 'crypto';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import paperlessClient from './paperless/paperlessClient.js';
import paperlessUpdate from './paperless/paperlessUpdateService.js';
import { PAPERLESS_TAGS, tagName } from '../config/paperlessTagsConfig.js';
import { resolveAccountId } from '../config/paperlessBankAccountsConfig.js';
import statements from './statementImportService.js';

/**
 * Pulls bank statements out of Paperless and parses them.
 *
 * Paperless is the delivery channel and the archive: statements are emailed to
 * bank.statements@heroncs.co.uk, a mail rule tags them `bank-statement`, and
 * this reads the OCR text. That gives retention, full-text search, the existing
 * viewer, and inclusion in the nightly paperless-backup export — none of which
 * a bespoke uploader would.
 *
 * Documents are filtered by **tag id**, not by a `tag:` search string. There is
 * a pre-existing `statements` tag holding 33 *supplier* statements of account —
 * an entirely different document that shares a word — and an id cannot drift
 * into matching it.
 *
 * Everything lands in the same statementImport / statementLine models the
 * CSV/OFX upload uses, so nothing downstream cares which route a line took.
 */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function models() {
  return {
    BankStatementDocument: mdb.PAPERLESS?.bankStatementDocument || null,
    StatementImport: mdb.INTERNAL?.statementImport || null,
  };
}

/** Flatten Paperless's custom_fields into the shape resolveAccountId expects. */
function toCustomFields(doc, fieldNames) {
  return (doc.custom_fields || []).map((entry) => {
    const fieldId = typeof entry.field === 'object' ? entry.field?.id : entry.field;
    return { fieldId, fieldName: fieldNames.get(fieldId) || '', value: entry.value };
  });
}

/**
 * Fetch `bank-statement` documents, parse each, and record the outcome.
 *
 * Idempotent on two levels: a document whose OCR text is unchanged since the
 * last parse is skipped outright, and importStatement itself no-ops on an
 * unchanged source hash. Re-running costs API calls and nothing else.
 */
export async function ingestStatements({ limit = 50, force = false } = {}) {
  const { BankStatementDocument, StatementImport } = models();
  if (!BankStatementDocument || !StatementImport) {
    return { fetched: 0, parsed: 0, needsReview: 0, failed: 0, skipped: 0, unattributed: 0 };
  }

  const api = paperlessClient.makeClient();
  const tagId = PAPERLESS_TAGS.bankStatement.id;

  // Field id -> name, so the account custom field can be found by name.
  const fieldNames = new Map();
  try {
    const defs = await api.listCustomFields({ page: 1, pageSize: 200 });
    for (const f of defs?.results || []) fieldNames.set(f.id, f.name);
  } catch (err) {
    logger.warn(`[bankStatementIngest] could not list custom fields: ${err.message}`);
  }

  let docs = [];
  try {
    const data = await api.listDocuments({ page: 1, pageSize: limit, tagsIdAll: tagId });
    docs = data?.results || [];
  } catch (err) {
    logger.error(`[bankStatementIngest] listing documents failed: ${err.message}`);
    return { fetched: 0, parsed: 0, needsReview: 0, failed: 0, skipped: 0, unattributed: 0, error: err.message };
  }

  const stats = { fetched: docs.length, parsed: 0, needsReview: 0, failed: 0, skipped: 0, unattributed: 0 };

  for (const doc of docs) {
    try {
      const ocrText = doc.content || '';
      const ocrTextHash = sha256(ocrText);
      const customFields = toCustomFields(doc, fieldNames);
      const { accountId, source } = resolveAccountId({
        customFields,
        correspondent: doc.correspondent != null ? { id: doc.correspondent } : null,
      });

      const cached = await BankStatementDocument.findOneAndUpdate(
        { paperlessId: doc.id },
        {
          $set: {
            paperlessId: doc.id,
            title: doc.title || '',
            ocrText,
            ocrTextHash,
            correspondent: { id: doc.correspondent ?? null },
            documentType: { id: doc.document_type ?? null },
            tags: (doc.tags || []).map(id => ({ id })),
            customFields,
            created: doc.created || null,
            added: doc.added || null,
            modified: doc.modified || null,
            originalFileName: doc.original_file_name || '',
            accountId,
            accountSource: source,
            fetchedAt: new Date(),
            deletedInPaperlessAt: null,
          },
        },
        { upsert: true, new: true },
      );

      // Unchanged text and already parsed: nothing to redo.
      if (!force && cached.parsedAt && cached.parseStatus !== 'pending') {
        const existing = await StatementImport.findOne({ paperlessId: doc.id, deletedAt: null }).lean();
        if (existing && cached.ocrTextHash === ocrTextHash) { stats.skipped += 1; continue; }
      }

      // Without an account the lines cannot be attributed, and attributing a
      // statement to the wrong account produces a confidently wrong
      // reconciliation. Held for a human rather than guessed at.
      if (accountId == null) {
        stats.unattributed += 1;
        await BankStatementDocument.updateOne({ paperlessId: doc.id }, {
          $set: { parseStatus: 'needs-review', parseError: 'Could not determine which bank account this statement belongs to' },
        });
        await tagBack(doc.id, 'bankStatementNeedsReview');
        continue;
      }

      if (!ocrText.trim()) {
        stats.failed += 1;
        await BankStatementDocument.updateOne({ paperlessId: doc.id }, {
          $set: { parseStatus: 'failed', parseError: 'Paperless holds no OCR text for this document' },
        });
        await tagBack(doc.id, 'bankStatementFailed');
        continue;
      }

      const result = await statements.importStatement({
        text: ocrText,
        accountId,
        format: 'ocr',
        source: 'paperless',
        paperlessId: doc.id,
        originalFileName: doc.original_file_name || doc.title || '',
        year: doc.created ? new Date(doc.created).getUTCFullYear() : null,
      });

      await BankStatementDocument.updateOne({ paperlessId: doc.id }, {
        $set: { parsedAt: new Date(), parseStatus: result.status, parseError: '' },
      });

      if (result.status === 'parsed') { stats.parsed += 1; await tagBack(doc.id, 'bankStatementParsed'); }
      else if (result.status === 'needs-review') { stats.needsReview += 1; await tagBack(doc.id, 'bankStatementNeedsReview'); }
      else { stats.failed += 1; await tagBack(doc.id, 'bankStatementFailed'); }
    } catch (err) {
      // One bad document must not abandon the batch.
      stats.failed += 1;
      logger.warn(`[bankStatementIngest] document ${doc.id} failed: ${err.message}`);
      await BankStatementDocument.updateOne(
        { paperlessId: doc.id },
        { $set: { parseStatus: 'failed', parseError: String(err.message).slice(0, 500) } },
      ).catch(() => {});
    }
  }

  return stats;
}

/**
 * Write the outcome back as a Paperless tag, so the state is visible to
 * someone looking at the document rather than only inside hcs-app.
 *
 * Merged, never replacing: dropping the `bank-statement` tag would make the
 * document invisible to the next run.
 */
async function tagBack(paperlessId, tagKey) {
  try {
    await paperlessUpdate.updatePaperlessDocumentTags(paperlessId, [tagName(tagKey)], { merge: true });
  } catch (err) {
    // Cosmetic. A tagging failure must not fail the parse that succeeded.
    logger.warn(`[bankStatementIngest] could not tag document ${paperlessId}: ${err.message}`);
  }
}

export default { ingestStatements };
