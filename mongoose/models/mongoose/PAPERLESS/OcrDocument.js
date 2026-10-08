// mongoose/models/mongoose/PAPERLESS/OcrDocument.js
import mongoose from 'mongoose';

const CustomFieldSchema = new mongoose.Schema({
  fieldId: Number,
  fieldName: String,
  value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const TagSchema = new mongoose.Schema({
  id: Number,
  name: String,
  slug: String,
}, { _id: false });

// Subcontractor draft: user-added line items persisted across draft reloads
// (Paperless custom fields only have _Line1 slots, so extras live here).
const DraftExtraLineSchema = new mongoose.Schema({
  Description: String,
  Quantity: Number,
  UnitPrice: Number,
  VATAmount: Number,
  NominalCode: Number,
  ProjectNumber: Number,
}, { _id: false });

// ── Processing state (Paperless migration H2) ─────────────────────────────
// hcs-app owns document process state; Paperless tags no longer drive it.
// Transitions and their rules live in services/paperless/documentStateService.js.
export const PROCESSING_STATES = ['awaiting_entry', 'entered', 'sent', 'manual_kashflow'];
export const EXCLUDED_REASONS = ['original_multiple', 'manually_added', 'not_for_kashflow'];

const ActorSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, default: null },
}, { _id: false });

// Who last changed a field and when
const ChangeStampSchema = new mongoose.Schema({
  at: Date,
  by: { type: ActorSchema, default: null },
}, { _id: false });

const ProcessingHistorySchema = new mongoose.Schema({
  field: { type: String, enum: ['processingState', 'statementReviewed', 'creditNote', 'excludedReason', 'documentType'] },
  from: mongoose.Schema.Types.Mixed,
  to: mongoose.Schema.Types.Mixed,
  action: String, // e.g. complete_entry, unlink, reopen_entry, backfill
  at: Date,
  by: { type: ActorSchema, default: null },
  note: { type: String, default: null },
}, { _id: false });

// ── Data entry (H5) ──
// What was keyed in on the hcs-app entry screen. Held here only, never written
// to the Paperless custom fields (decision 3 Oct 2026); the KashFlow draft
// reads it first and falls back to the Paperless fields for anything blank.
const EntryLineSchema = new mongoose.Schema({
  description: { type: String, default: null },
  quantity:    { type: Number, default: null },
  price:       { type: Number, default: null },
  total:       { type: Number, default: null }, // net line total, as Total_LineN
  vatRate:     { type: Number, default: null }, // percent, as VAT_LineN
}, { _id: false });

const EntrySchema = new mongoose.Schema({
  // Invoice header (Paperless fields 1–6)
  invoiceNumber: { type: String, default: null },
  invoiceDate:   { type: Date, default: null },
  dueDate:       { type: Date, default: null },
  totalGoods:    { type: Number, default: null },
  totalVat:      { type: Number, default: null },
  invoiceTotal:  { type: Number, default: null },
  lines:         { type: [EntryLineSchema], default: undefined },
  // Bank statement (Paperless fields 53–57)
  bank: {
    type: new mongoose.Schema({
      accountId:      { type: Number, default: null },
      periodStart:    { type: Date, default: null },
      periodEnd:      { type: Date, default: null },
      openingBalance: { type: Number, default: null },
      closingBalance: { type: Number, default: null },
    }, { _id: false }),
    default: undefined,
  },
  savedAt: Date,
  savedBy: { type: ActorSchema, default: null },
}, { _id: false });

const OcrDocumentSchema = new mongoose.Schema({
  paperlessId: { type: Number, index: true, unique: true },
  title: String,
  ocrText: { type: String, default: '' },
  correspondent: { id: Number, name: String },
  documentType: { id: Number, name: String },
  tags: [TagSchema],
  created: Date,
  added: Date,
  modified: Date,
  archiveSerialNumber: String,
  originalFileName: String,
  archivedFileName: String,
  customFields: [CustomFieldSchema],
  // Optional linkage to a created KashFlow Purchase (post-send enrichment)
  kashflowPurchaseId:     { type: Number, default: null, index: true },
  kashflowPurchaseNumber: { type: Number, default: null },
  kashflowPermalink:      { type: String, default: null },
  lastSentAt:             { type: Date,   default: null, index: true },
  lastSendMode:           { type: String, enum: ['direct', 'webhook', null], default: null, index: true },
  lastSendStatus:         { type: Number, default: null },
  modifiedAtLastSend:     { type: Date,   default: null },
  kfSendLockedAt:         { type: Date,   default: null }, // in-flight send claim — blocks concurrent sends (stale after 5 min)
  draftExtraLines:        { type: [DraftExtraLineSchema], default: undefined },
  sendCount:              { type: Number },
  fetchedAt:              { type: Date, default: () => new Date() },
  // Set by the grab's reconciliation pass when a full unfiltered sweep no longer sees
  // this document in Paperless (deleted there). Cleared automatically if it reappears.
  deletedInPaperlessAt:   { type: Date, default: null, index: true },
  error: { type: String, default: null },

  // ── Processing state (H2) ──
  // null = not yet classified (H3 ingest or the H7 backfill sets it). Only
  // Purchase and Subcontractor Invoices ever get a state.
  processingState:          { type: String, enum: [...PROCESSING_STATES, null], default: null, index: true },
  processingStateChanged:   { type: ChangeStampSchema, default: null },
  // Supplier statements: reviewed (PB-10)
  statementReviewed:        { type: Boolean, default: false },
  statementReviewedChanged: { type: ChangeStampSchema, default: null },
  // Credit note flag (PB-9, PB-12); flagging moves the invoice to manual_kashflow
  creditNote:               { type: Boolean, default: false },
  creditNoteChanged:        { type: ChangeStampSchema, default: null },
  // Kept out of the invoice queues (Paperless tags 4 and 11, or "not for kashflow")
  excludedReason:           { type: String, enum: [...EXCLUDED_REASONS, null], default: null },
  excludedReasonChanged:    { type: ChangeStampSchema, default: null },
  // Why it's not for KashFlow, in the words of whoever marked it
  excludedNote:             { type: String, default: null },
  processingHistory:        { type: [ProcessingHistorySchema], default: undefined },
  // When H3 ingest or the H7 backfill first classified the document. A supplier
  // statement has no processingState, so this is what tells "not reviewed"
  // apart from "not classified yet" (statementReviewed defaults to false).
  classifiedAt:             { type: Date, default: null },
  entry:                    { type: EntrySchema, default: undefined },

  // ── Read off the PDF (documentReadingService) ──
  // What the invoice reader found: { version, at, hasText, pages, score,
  // fields: { invoiceNumber: {value, page, box}, … }, lines: […], lineCount,
  // vatNumbers: [{number, page, box}], terms: {text, days, …}, error }.
  // `score` (0–3: number, date, total found) orders the queue.
  reading:                  { type: mongoose.Schema.Types.Mixed, default: undefined },
  // How the reading compared with what was saved, per field: matched,
  // corrected, filled (nothing read, typed by hand), missed (read, left blank)
  readingOutcome:           { type: mongoose.Schema.Types.Mixed, default: undefined },

  // ── Does it look like its type? (documentTypeCheck) ──
  // { version, at, concern: {code, message} | null, open, confirmed: {code, at, by} | null }.
  // `open` puts it in the Check the type queue.
  typeCheck:                { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { timestamps: true });

OcrDocumentSchema.index({ 'reading.score': -1 });
OcrDocumentSchema.index({ 'typeCheck.open': 1 });

export default {
  modelName: 'OcrDocument',
  schema: OcrDocumentSchema,
};
