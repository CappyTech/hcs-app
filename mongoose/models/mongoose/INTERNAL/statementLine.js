import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * One line from a bank statement — what the bank says actually happened.
 *
 * This is the independent side of the reconciliation. Everything else in the
 * module describes what KashFlow believes; a statement line with no
 * corresponding bank transaction is money that moved and was never booked,
 * which is the one thing reconciling KashFlow against itself can never find.
 */

const STATUSES = [
  'unmatched',   // no bank transaction found
  'matched',     // ties to a KashFlow bank transaction
  'ignored',     // deliberately set aside, with a reason
];

const statementLineSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'statementImport', required: true, index: true },
    accountId: { type: Number, required: true, index: true },

    date: { type: Date, required: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },

    // Signed: positive is money in, negative money out — the same convention
    // bankLinkService.signedAmount applies to KashFlow lines, so the two sides
    // compare without translation.
    amount: { type: Number, required: true },
    // Running balance as printed. Used for the chain check, and to spot a
    // missing line even when the amounts themselves parse cleanly.
    balance: { type: Number, default: null },

    /**
     * sha256 of accountId + date + amount + normalised description.
     *
     * Unique per account. Statement exports overlap constantly — people pull
     * "last 3 months" twice — so re-ingesting the same period must not
     * duplicate lines. Deliberately excludes balance: the same transaction can
     * legitimately print a different running balance if an earlier line was
     * later amended by the bank.
     */
    lineHash: { type: String, required: true },

    // The account is part of a bank line's identity, not decoration: an
    // internal transfer is two ledger lines sharing one KashFlow Id. A
    // statement line belongs to exactly one account, so recording only the id
    // would leave the ledger line it matched ambiguous.
    matchedBankTransactionId: { type: Number, default: null, index: true },
    matchedBankAccountId: { type: Number, default: null, index: true },
    matchedAt: { type: Date, default: null },
    matchConfidence: { type: Number, default: 0 },

    status: { type: String, enum: STATUSES, default: 'unmatched', index: true },
    ignoredReason: { type: String, default: '', trim: true, maxlength: 500 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The dedupe guarantee. Partial so soft-deleted lines do not block a re-import.
statementLineSchema.index(
  { accountId: 1, lineHash: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null }, name: 'account_linehash_unique' },
);

// The unmatched worklist, and the three-way match sweep.
statementLineSchema.index({ accountId: 1, status: 1, date: -1 });
statementLineSchema.index({ accountId: 1, date: 1, amount: 1 });

export default { modelName: 'statementLine', schema: statementLineSchema };
export { STATUSES };
