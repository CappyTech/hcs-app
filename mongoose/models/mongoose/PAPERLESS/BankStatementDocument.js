import mongoose from 'mongoose';

/**
 * A bank statement held in Paperless-ngx.
 *
 * Deliberately separate from OcrDocument rather than sharing it. OcrDocument
 * feeds the purchase-drafting queue at /paperless/ocr, and a bank statement
 * appearing there is an invitation to raise a purchase from it. The two have
 * different lifecycles, different reviewers and different sensitivity — a
 * statement lists every payee and wage transfer the company has made.
 *
 * This mirrors what Paperless holds. The parsed result lives in
 * INTERNAL.statementImport / statementLine, which is where reconciliation
 * reads from.
 */

const TagSchema = new mongoose.Schema({
  id: Number,
  name: String,
  slug: String,
}, { _id: false });

const CustomFieldSchema = new mongoose.Schema({
  fieldId: Number,
  fieldName: String,
  value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const bankStatementDocumentSchema = new mongoose.Schema({
  paperlessId: { type: Number, index: true, unique: true, required: true },

  title: String,
  // The OCR text the parser works from.
  ocrText: { type: String, default: '' },
  // sha256 of ocrText. Paperless can re-OCR a document, and re-parsing is only
  // worth doing when the text actually changed.
  ocrTextHash: { type: String, default: null, index: true },

  correspondent: { id: Number, name: String },
  documentType: { id: Number, name: String },
  tags: [TagSchema],
  customFields: [CustomFieldSchema],

  created: Date,
  added: Date,
  modified: Date,
  originalFileName: String,
  archivedFileName: String,

  // Which of our bank accounts this statement belongs to. Taken from the
  // bank_account_id custom field, falling back to a correspondent mapping.
  // Null means it could not be determined and needs a human to say.
  accountId: { type: Number, default: null, index: true },
  accountSource: { type: String, enum: ['custom-field', 'correspondent', 'manual', null], default: null },

  // Set once the parser has run. The parse itself lives in statementImport.
  parsedAt: { type: Date, default: null },
  parseStatus: {
    type: String,
    enum: ['pending', 'parsed', 'needs-review', 'failed', null],
    default: 'pending',
    index: true,
  },
  parseError: { type: String, default: null },

  fetchedAt: { type: Date, default: () => new Date() },
  // Set when a full sweep no longer sees this document in Paperless.
  deletedInPaperlessAt: { type: Date, default: null, index: true },
}, { timestamps: true });

export default {
  modelName: 'bankStatementDocument',
  schema: bankStatementDocumentSchema,
};
