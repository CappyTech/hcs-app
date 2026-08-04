import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * A settlement set: N bank lines matched against M documents.
 *
 * One shape covers both directions of many-to-one, which is why bankLines and
 * documents are both arrays:
 *   - a batch payment is 1 bank line + N documents
 *   - a part-paid invoice is N bank lines + 1 document
 *
 * KashFlow is never written to. It stays the system of record; this collection
 * is our own view of what has been accounted for, plus who signed it off.
 *
 * INTERNAL namespace, so mongooseDatabaseService attaches auditPlugin
 * automatically — do not add it here.
 */

// How the bank line was tied to its document(s).
const MATCH_TYPES = [
  'document',     // resolved to one invoice/purchase
  'batch',        // one bank line settling several documents
  'transfer',     // money moving between our own accounts, no document
  'journal',      // journal entry
  'no-document',  // bank charge, interest, loan repayment — nothing to match
];

// The human decision.
const STATUSES = ['suggested', 'confirmed', 'rejected', 'superseded'];

// The machine observation, tracked separately so a re-sync can never quietly
// overwrite a human's sign-off. See the note on `integrity` below.
const INTEGRITIES = ['ok', 'drifted', 'missing'];

// How the match was proposed.
const ORIGINS = [
  'link',   // KashFlow's own EntityName + ResourceNumber
  'rule',   // an accountant-authored bankRule
  'auto',   // the scoring matcher
  'manual', // a person picked it
];

const bankLineSchema = new mongoose.Schema({
  source: { type: String, enum: ['banktransaction', 'statement'], default: 'banktransaction' },

  // KashFlow bankTransaction.Id. Not a ref — it lives in the REST namespace,
  // on a different connection, and is replaced wholesale by each sync.
  bankTransactionId: { type: Number, default: null, index: true },
  statementLineId:   { type: mongoose.Schema.Types.ObjectId, ref: 'statementLine', default: null },

  date:        { type: Date, default: null },
  // Signed: positive is money in, negative is money out. Bank lines carry
  // PaidIn/PaidOut as separate positive columns; normalising here means
  // allocation arithmetic is plain addition.
  amount:      { type: Number, default: 0 },
  description: { type: String, default: '', trim: true, maxlength: 500 },

  // sha256 of the facts this match was made against. The drift job recomputes
  // it and flags a mismatch rather than silently re-matching.
  factHash: { type: String, default: null },
}, { _id: false });

const matchedDocumentSchema = new mongoose.Schema({
  kind:   { type: String, enum: ['invoice', 'purchase', 'journal'], required: true },
  kfId:   { type: Number, default: null },
  kfNumber: { type: Number, default: null },

  // "<kind>:<kfId>" — the value the confirmed-uniqueness index is built on.
  docKey: { type: String, required: true },

  // How much of the bank total this document accounts for. For a single
  // document match it equals the bank amount; for a batch it is that
  // document's share.
  allocatedAmount: { type: Number, default: 0 },

  // Snapshot of the document as it looked when matched, so the UI can render
  // history without re-reading REST, and so drift is detectable.
  docGross:  { type: Number, default: null },
  docDate:   { type: Date, default: null },
  partyName: { type: String, default: '', trim: true, maxlength: 300 },

  factHash: { type: String, default: null },
}, { _id: false });

const bankMatchSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    accountId: { type: Number, required: true, index: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    matchType: { type: String, enum: MATCH_TYPES, required: true },

    bankLines: { type: [bankLineSchema], default: [] },
    documents: { type: [matchedDocumentSchema], default: [] },

    totals: {
      bankTotal:     { type: Number, default: 0 },
      documentTotal: { type: Number, default: 0 },
      variance:      { type: Number, default: 0 },
    },

    status: { type: String, enum: STATUSES, default: 'suggested', index: true },

    // `status` is the human decision; `integrity` is what the machine has
    // since observed about the underlying data. A re-sync that changes a
    // document never rewrites `status` — it sets integrity to 'drifted' and
    // records why. Sign-off history is therefore never silently destroyed.
    integrity:       { type: String, enum: INTEGRITIES, default: 'ok', index: true },
    driftFlags:      { type: [String], default: [] },
    driftDetectedAt: { type: Date, default: null },

    confidence: { type: Number, default: 0, min: 0, max: 100 },
    scoreBreakdown: {
      amount:    { type: Number, default: 0 },
      date:      { type: Number, default: 0 },
      name:      { type: Number, default: 0 },
      reference: { type: Number, default: 0 },
      penalty:   { type: Number, default: 0 },
    },
    // Human-readable justifications shown on the match screen.
    reasons: { type: [String], default: [] },

    origin:        { type: String, enum: ORIGINS, default: 'auto' },
    appliedRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'bankRule', default: null },

    // Review trail. Name/email are denormalised so the record still reads
    // correctly after a user is renamed or deleted.
    reviewedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedByName:  { type: String, default: '', trim: true, maxlength: 200 },
    reviewedByEmail: { type: String, default: '', trim: true, maxlength: 320 },
    reviewedAt:    { type: Date, default: null },
    reviewNote:    { type: String, default: '', trim: true, maxlength: 1000 },
    rejectedReason: { type: String, default: '', trim: true, maxlength: 1000 },

    // Corrections supersede rather than mutate, so the audit trail of what was
    // believed at sign-off time survives intact.
    supersedes:   { type: mongoose.Schema.Types.ObjectId, ref: 'bankMatch', default: null },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'bankMatch', default: null },
    supersededAt: { type: Date, default: null },

    signOffId: { type: mongoose.Schema.Types.ObjectId, ref: 'bankSignOff', default: null, index: true },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// A bank line, and a document, may each be claimed by only one *confirmed*
// match. Multikey partial-unique indexes enforce this across documents.
//
// Do not rely on these alone: src/db/mongo.js in hcs-sync already carries
// workarounds for restricted partialFilterExpression support, so
// bankReconciliationService performs the same check at write time.
bankMatchSchema.index(
  { 'bankLines.bankTransactionId': 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' }, name: 'confirmed_bankline_unique' },
);
bankMatchSchema.index(
  { 'documents.docKey': 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' }, name: 'confirmed_dockey_unique' },
);

// The worklist: one account, newest first, filtered by where it has got to.
bankMatchSchema.index({ accountId: 1, status: 1, 'bankLines.date': -1 });
// The exception report.
bankMatchSchema.index({ status: 1, integrity: 1 });

export default { modelName: 'bankMatch', schema: bankMatchSchema };
export { MATCH_TYPES, STATUSES, INTEGRITIES, ORIGINS };
