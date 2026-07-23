import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * payrollRun — a single payroll processing run for a given period.
 *
 * A run is created as 'draft', employees are attached and calculated,
 * then it is 'locked' before submitting to HMRC and KashFlow.
 * Once an RTI submission is made the run moves to 'submitted'.
 *
 * Entries are stored in separate INTERNAL.payrollEntry documents
 * (one per employee per run) and referenced via the entries array.
 */
const payrollRunSchema = new mongoose.Schema({
  uuid: {
    type: String,
    unique: true,
    required: true,
    default: () => crypto.randomUUID()
  },

  // ── Tax period ────────────────────────────────────────────────────────────
  taxYear:   { type: String, required: true },      // e.g. '2025/26'
  taxMonth:  { type: Number, min: 1, max: 12 },     // 1=April, 12=March — null for non-monthly
  taxWeek:   { type: Number, min: 1, max: 56 },     // 1-52 (or 53/56 for leap) — null for monthly

  frequency: {
    type: String,
    enum: ['weekly', 'fortnightly', 'monthly'],
    required: true
  },

  periodStart: { type: Date, required: true },
  periodEnd:   { type: Date, required: true },

  // The date employees are actually paid — used in the FPS PaymentDate element
  paymentDate: { type: Date, required: true },

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['draft', 'locked', 'submitted'],
    default: 'draft'
  },

  // ── Entries ───────────────────────────────────────────────────────────────
  entries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'payrollEntry' }],

  // ── Aggregates (computed when run is calculated / locked) ─────────────────
  totals: {
    grossPay:        { type: mongoose.Decimal128, default: 0 },
    taxDeducted:     { type: mongoose.Decimal128, default: 0 },
    employeeNI:      { type: mongoose.Decimal128, default: 0 },
    employerNI:      { type: mongoose.Decimal128, default: 0 },
    employeePension: { type: mongoose.Decimal128, default: 0 },
    employerPension: { type: mongoose.Decimal128, default: 0 },
    netPay:          { type: mongoose.Decimal128, default: 0 },
    studentLoan:     { type: mongoose.Decimal128, default: 0 }
  },

  // ── KashFlow journal ──────────────────────────────────────────────────────
  kashflowJournalRef: { type: String, default: null },  // Journal ID returned by KashFlow API
  journalPostedAt:    { type: Date, default: null },
  journalPostingAt:   { type: Date, default: null },    // in-flight claim — blocks concurrent posting (stale after 5 min)
  journalLastError:   { type: String, default: null },  // last posting failure, surfaced for retry decisions

  notes: { type: String, trim: true, maxlength: 2000 }
}, {
  timestamps: true
});

// Prevent duplicate runs for the same period + frequency
payrollRunSchema.index({ taxYear: 1, taxMonth: 1, taxWeek: 1, frequency: 1 }, { unique: true, sparse: true });
payrollRunSchema.index({ periodStart: 1, periodEnd: 1, frequency: 1 });
payrollRunSchema.index({ status: 1 });

export default {
  modelName: 'payrollRun',
  schema: payrollRunSchema
};
