import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * payrollEntry — per-employee calculation record within a payrollRun.
 *
 * Stores a full snapshot of all gross-to-net figures at run time,
 * including YTD totals after this run.  Fields in overrideFlags were
 * manually adjusted after auto-calculation.
 *
 * All monetary amounts stored as Decimal128 to avoid floating-point drift.
 */
const payrollEntrySchema = new mongoose.Schema({
  uuid: {
    type: String,
    unique: true,
    required: true,
    default: () => crypto.randomUUID()
  },

  // ── References ────────────────────────────────────────────────────────────
  runId:      { type: mongoose.Schema.Types.ObjectId, ref: 'payrollRun', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee',    required: true, index: true },

  paymentDate: { type: Date, required: true },

  // ── Gross pay ─────────────────────────────────────────────────────────────
  grossPay:                  { type: mongoose.Decimal128, default: 0 },  // total gross for period
  grossPayFromAttendance:    { type: mongoose.Decimal128, default: 0 },  // auto-calculated from attendance records
  grossPayManualAdjustment:  { type: mongoose.Decimal128, default: 0 },  // manual correction / bonus

  // taxableGross: grossPay minus salary-sacrifice pension (if applicable)
  taxableGross: { type: mongoose.Decimal128, default: 0 },

  // ── PAYE (snapshot of employee tax settings at run time) ─────────────────
  taxCode:   { type: String, required: true },   // e.g. '1257L'
  taxBasis:  { type: String, required: true },   // 'cumulative' | 'week1/month1'
  taxDeducted: { type: mongoose.Decimal128, default: 0 },

  // ── National Insurance ────────────────────────────────────────────────────
  niCategory:   { type: String, required: true },  // e.g. 'A'
  employeeNI:   { type: mongoose.Decimal128, default: 0 },
  employerNI:   { type: mongoose.Decimal128, default: 0 },

  // ── Pension ───────────────────────────────────────────────────────────────
  employeePensionRate: { type: mongoose.Decimal128, default: 0 },  // % used in this run
  employerPensionRate: { type: mongoose.Decimal128, default: 0 },
  employeePension:     { type: mongoose.Decimal128, default: 0 },
  employerPension:     { type: mongoose.Decimal128, default: 0 },
  salarySacrifice:     { type: Boolean, default: false },

  // ── Student / postgrad loan ───────────────────────────────────────────────
  studentLoanPlan:         { type: String, default: 'none' },
  studentLoanDeduction:    { type: mongoose.Decimal128, default: 0 },
  postgradLoanDeduction:   { type: mongoose.Decimal128, default: 0 },

  // ── Net pay ───────────────────────────────────────────────────────────────
  netPay: { type: mongoose.Decimal128, default: 0 },

  // ── Year-to-date AFTER this run ───────────────────────────────────────────
  ytdGrossPayAfter:    { type: mongoose.Decimal128, default: 0 },
  ytdTaxPaidAfter:     { type: mongoose.Decimal128, default: 0 },
  ytdEmployeeNIAfter:  { type: mongoose.Decimal128, default: 0 },
  ytdEmployerNIAfter:  { type: mongoose.Decimal128, default: 0 },

  // ── Override tracking ─────────────────────────────────────────────────────
  // List of field names that were manually overridden after auto-calculation
  overrideFlags: [{ type: String }],

  notes: { type: String, trim: true, maxlength: 2000 }
}, {
  timestamps: true
});

// One entry per employee per run
payrollEntrySchema.index({ runId: 1, employeeId: 1 }, { unique: true });

export default {
  modelName: 'payrollEntry',
  schema: payrollEntrySchema
};
