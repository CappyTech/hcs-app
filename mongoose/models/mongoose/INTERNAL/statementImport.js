import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * One parsed bank statement — a batch of statementLine rows.
 *
 * Two sources feed this, and they land in the same shape on purpose so
 * everything downstream is source-agnostic:
 *   'paperless' — OCR text from a statement PDF held in Paperless
 *   'upload'    — a CSV/OFX export uploaded directly
 *
 * CSV is the more reliable of the two: OCR can transpose a digit, and a wrong
 * amount corrupts a reconciliation silently. balanceChainOk is what makes that
 * detectable — see statementParserService.
 */

const SOURCES = ['paperless', 'upload'];
const STATUSES = ['parsed', 'needs-review', 'failed'];

const statementImportSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    source: { type: String, enum: SOURCES, required: true },

    // Set for source 'paperless'. Uniqueness is enforced by a partial index
    // below rather than `unique: true, sparse: true` here: sparse only skips
    // *missing* fields, and this one defaults to null, so every upload would
    // write an explicit null and the second would collide with the first.
    paperlessId: { type: Number, default: null },

    // Set for source 'upload'.
    originalFileName: { type: String, default: '', trim: true, maxlength: 300 },
    storedFileName: { type: String, default: '', trim: true, maxlength: 300 },

    accountId: { type: Number, default: null, index: true },
    accountName: { type: String, default: '', trim: true, maxlength: 300 },

    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    openingBalance: { type: Number, default: null },
    closingBalance: { type: Number, default: null },

    /**
     * Whether the running-balance column reconciles down the page:
     *   balance[n-1] + amount[n] === balance[n]  for every line, and
     *   opening + sum(amounts) === closing
     *
     * False means the parse is wrong somewhere, so none of its lines are
     * trusted. This is the single most valuable check in the whole parser,
     * and the reason OCR is usable here at all.
     */
    balanceChainOk: { type: Boolean, default: false },
    balanceChainError: { type: String, default: '', trim: true, maxlength: 500 },

    // Which layout profile parsed it, so a bad profile can be traced.
    parserProfile: { type: String, default: '', trim: true, maxlength: 100 },

    status: { type: String, enum: STATUSES, default: 'needs-review', index: true },

    lineCount: { type: Number, default: 0 },
    // Lines whose lineHash already existed for this account.
    duplicateCount: { type: Number, default: 0 },

    // sha256 of the source text, so an unchanged re-ingest is a no-op.
    sourceHash: { type: String, default: null, index: true },

    warnings: { type: [String], default: [] },

    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    importedByName: { type: String, default: '', trim: true, maxlength: 200 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

statementImportSchema.index({ accountId: 1, periodEnd: -1 });

// One import per Paperless document, so a repeated grab updates rather than
// duplicates. Restricted to real numeric ids, which excludes both the null
// default and a missing field — see the note on the field above.
statementImportSchema.index(
  { paperlessId: 1 },
  {
    unique: true,
    partialFilterExpression: { paperlessId: { $type: 'number' } },
    name: 'paperless_document_unique',
  },
);

export default { modelName: 'statementImport', schema: statementImportSchema };
export { SOURCES, STATUSES };
