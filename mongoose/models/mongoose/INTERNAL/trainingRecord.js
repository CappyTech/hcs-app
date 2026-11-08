import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Training & cards (Health & Safety, phase 5a).
 *
 * One record per card or course a person holds: CSCS and other site cards,
 * plant tickets, first aid, and courses such as manual handling. The person
 * is an employee or a CIS subcontractor; `personName` names an operative a
 * subcontractor firm sends who has no record of their own.
 *
 * healthSafetyComplianceService reminds the Health & Safety area, and the
 * person, before `expiryDate`.
 */
export const TRAINING_TYPES = [
  'CSCS card', 'CPCS card', 'NPORS card', 'CISRS card', 'ECS card',
  'SMSTS', 'SSSTS', 'IPAF', 'PASMA',
  'First Aid at Work', 'Emergency First Aid at Work',
  'Asbestos Awareness', 'Manual Handling', 'Working at Height', 'Abrasive Wheels',
  'Chainsaw (NPTC/Lantra)', 'Pesticides (PA1/PA6)',
  'Fire Marshal', 'Toolbox Talk', 'Other',
];

const trainingRecordSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  // ── Who holds it ────────────────────────────────────────────────────
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
  subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier', default: null },
  // An operative of the subcontractor firm, when it isn't the firm's own card.
  personName: { type: String, trim: true, maxlength: 120 },

  // ── What it is ──────────────────────────────────────────────────────
  type: { type: String, enum: TRAINING_TYPES, required: true },
  title: { type: String, trim: true, maxlength: 120 }, // e.g. card colour, course name when 'Other'
  cardNumber: { type: String, trim: true, maxlength: 60 },
  provider: { type: String, trim: true, maxlength: 120 },

  // ── Dates ───────────────────────────────────────────────────────────
  issuedDate: { type: Date, default: null },
  expiryDate: { type: Date, default: null }, // none = doesn't expire

  // ── Checked ─────────────────────────────────────────────────────────
  // When someone saw the card or certificate (or checked it online).
  checkedDate: { type: Date, default: null },

  notes: { type: String, trim: true, maxlength: 2000 },
}, {
  timestamps: true,
});

trainingRecordSchema.pre('validate', function (next) {
  if (this.employeeId && this.subcontractorId) {
    return next(new Error('A training record belongs to an employee or a subcontractor, not both.'));
  }
  if (!this.employeeId && !this.subcontractorId) {
    return next(new Error('Choose the employee or subcontractor who holds this card or training.'));
  }
  if (this.issuedDate && this.expiryDate && this.expiryDate < this.issuedDate) {
    return next(new Error('The expiry date is before the issue date.'));
  }
  next();
});

trainingRecordSchema.index({ employeeId: 1 });
trainingRecordSchema.index({ subcontractorId: 1 });
trainingRecordSchema.index({ expiryDate: 1 });
trainingRecordSchema.index({ type: 1 });

export default {
  modelName: 'trainingRecord',
  schema: trainingRecordSchema,
};
