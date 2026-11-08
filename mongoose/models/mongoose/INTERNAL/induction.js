import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Site inductions (Health & Safety, phase 5b).
 *
 * One record per person inducted onto a site (a contract). The person is an
 * employee or a CIS subcontractor; `personName` names an operative a
 * subcontractor firm sends. Site Managers and Supervisors record inductions
 * on their own sites through /inductions/record, which checks the contract;
 * the Health & Safety area records them anywhere through the generic pages.
 *
 * `expiryDate` is when a re-induction is due (optional);
 * healthSafetyComplianceService reminds before it.
 */
export const INDUCTION_TOPICS = [
  'Site rules and welfare', 'Emergency and fire procedures', 'First aid',
  'PPE', 'Site hazards', 'RAMS briefed', 'Plant, tools and permits',
  'Environment and waste',
];

const inductionSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  // ── Where ───────────────────────────────────────────────────────────
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract', required: true },

  // ── Who ─────────────────────────────────────────────────────────────
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
  subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier', default: null },
  personName: { type: String, trim: true, maxlength: 120 },

  // ── The induction ───────────────────────────────────────────────────
  date: { type: Date, required: true },
  inductedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  topics: [{ type: String, enum: INDUCTION_TOPICS }],
  // The person signed or otherwise confirmed they understood it.
  acknowledged: { type: Boolean, default: false },
  // Re-induction due (none = doesn't need one).
  expiryDate: { type: Date, default: null },

  notes: { type: String, trim: true, maxlength: 2000 },
}, {
  timestamps: true,
});

inductionSchema.pre('validate', function (next) {
  if (this.employeeId && this.subcontractorId) {
    return next(new Error('An induction is for an employee or a subcontractor, not both.'));
  }
  if (!this.employeeId && !this.subcontractorId) {
    return next(new Error('Choose the employee or subcontractor who was inducted.'));
  }
  if (this.date && this.expiryDate && this.expiryDate < this.date) {
    return next(new Error('The re-induction date is before the induction.'));
  }
  next();
});

inductionSchema.index({ contractId: 1, date: -1 });
inductionSchema.index({ employeeId: 1 });
inductionSchema.index({ subcontractorId: 1 });
inductionSchema.index({ expiryDate: 1 });

export default {
  modelName: 'induction',
  schema: inductionSchema,
};
