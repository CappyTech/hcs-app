import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * An accountant-authored rule for classifying bank lines that carry no
 * KashFlow document link.
 *
 * Those lines are not unmatched purchases waiting to be found — they are
 * postings to nominal accounts: wages control, directors loan, CIS deductions,
 * VAT, bank charges, loan repayments. KashFlow already names the nominal in
 * the transaction's `Type`, and across the live data there are only 47
 * distinct values, the top 20 covering 92.5% of the 2,547 such lines. A rule
 * keyed on `Type` therefore classifies almost all of them, and turns a
 * recurring monthly chore into a one-time setup.
 *
 * Rules produce suggestions. `autoConfirm` is opt-in per rule and admin-only,
 * because it is the single place the "a person confirms every match"
 * guarantee is relaxed.
 */

const MATCH_TYPES = ['no-document', 'transfer', 'journal'];

const conditionsSchema = new mongoose.Schema({
  // KashFlow's nominal narrative — the primary signal.
  typeEquals: { type: String, default: '', trim: true, maxlength: 200 },
  typeContains: { type: String, default: '', trim: true, maxlength: 200 },

  // Free-text description. 831 of the 2,547 lines have no Comment at all, so
  // this refines a Type rule rather than standing on its own.
  commentContains: { type: String, default: '', trim: true, maxlength: 200 },

  // null means "any account".
  accountId: { type: Number, default: null },

  direction: { type: String, enum: ['in', 'out', 'any'], default: 'any' },

  // Absolute amounts, inclusive. Both optional.
  amountEquals: { type: Number, default: null },
  amountMin: { type: Number, default: null },
  amountMax: { type: Number, default: null },
}, { _id: false });

const actionSchema = new mongoose.Schema({
  matchType: { type: String, enum: MATCH_TYPES, default: 'no-document' },
  // Free-text grouping for reporting — 'payroll', 'tax', 'finance costs'.
  category: { type: String, default: '', trim: true, maxlength: 100 },
  nominalCode: { type: Number, default: null },
  // For matchType 'transfer': the account the money moved to or from.
  counterpartAccountId: { type: Number, default: null },
  note: { type: String, default: '', trim: true, maxlength: 500 },
}, { _id: false });

const bankRuleSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    enabled: { type: Boolean, default: true, index: true },

    // Lower runs first. The first matching rule wins, so ordering is how an
    // accountant expresses "this specific case, otherwise the general one".
    priority: { type: Number, default: 100, index: true },

    conditions: { type: conditionsSchema, default: () => ({}) },
    action: { type: actionSchema, default: () => ({}) },

    /**
     * Confirm matches from this rule without review.
     *
     * Off by default and admin-only. Worth it for something like a fixed
     * monthly loan repayment; not worth it for anything whose amount or
     * counterparty varies.
     */
    autoConfirm: { type: Boolean, default: false },

    // Seeded rules ship with the feature; a user can edit or disable them but
    // the flag records where they came from.
    seeded: { type: Boolean, default: false },

    stats: {
      lastAppliedAt: { type: Date, default: null },
      appliedCount: { type: Number, default: 0 },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    createdByName: { type: String, default: '', trim: true, maxlength: 200 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Evaluation order.
bankRuleSchema.index({ enabled: 1, priority: 1, createdAt: 1 });

export default { modelName: 'bankRule', schema: bankRuleSchema };
export { MATCH_TYPES };
