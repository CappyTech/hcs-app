import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * An accountant closing a period on one bank account.
 *
 * This is our own sign-off, not KashFlow's — KashFlow is never written to.
 * Where a KashFlow reconciliation covers the same period, its id is recorded
 * in kfReconciliationId so the two can be compared, but ours stands alone.
 *
 * Reopening is deliberately a recorded state change rather than a delete: a
 * period that was signed and later reopened is exactly the thing an auditor
 * wants to see.
 */

const STATUSES = ['open', 'signed', 'reopened'];

const bankSignOffSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    accountId:   { type: Number, required: true, index: true },
    // Denormalised: six account ids in the live data have no bankaccounts
    // document at all, so the name cannot be assumed resolvable later.
    accountName: { type: String, default: '', trim: true, maxlength: 300 },

    periodStart: { type: Date, required: true },
    periodEnd:   { type: Date, required: true },

    openingBalance: { type: Number, default: 0 },
    // Per the bank statement, where one has been ingested.
    closingBalancePerStatement: { type: Number, default: null },
    // Per KashFlow's ledger — opening plus the period's movements.
    closingBalancePerLedger:    { type: Number, default: 0 },
    variance:                   { type: Number, default: 0 },

    matchedCount:   { type: Number, default: 0 },
    unmatchedCount: { type: Number, default: 0 },
    unmatchedValue: { type: Number, default: 0 },

    // KashFlow's own reconciliation covering this period, if any. Only one
    // exists in the live data, so this is almost always null.
    kfReconciliationId: { type: Number, default: null },

    status: { type: String, enum: STATUSES, default: 'open', index: true },

    signedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    signedByName:  { type: String, default: '', trim: true, maxlength: 200 },
    signedByEmail: { type: String, default: '', trim: true, maxlength: 320 },
    signedAt:      { type: Date, default: null },

    reopenedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    reopenedByName: { type: String, default: '', trim: true, maxlength: 200 },
    reopenedAt:     { type: Date, default: null },
    reopenReason:   { type: String, default: '', trim: true, maxlength: 1000 },

    notes: { type: String, default: '', trim: true, maxlength: 2000 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

bankSignOffSchema.pre('validate', function (next) {
  if (this.periodStart && this.periodEnd && this.periodEnd < this.periodStart) {
    return next(new Error('Period end must be on or after the period start.'));
  }
  next();
});

bankSignOffSchema.index({ accountId: 1, periodEnd: -1 });
// One signed sign-off per account per period. A reopened period may be signed
// again, which supersedes by status rather than by creating a duplicate.
bankSignOffSchema.index(
  { accountId: 1, periodStart: 1, periodEnd: 1 },
  { unique: true, partialFilterExpression: { status: 'signed' }, name: 'signed_period_unique' },
);

export default { modelName: 'bankSignOff', schema: bankSignOffSchema };
export { STATUSES };
