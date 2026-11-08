import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Accident book (Health & Safety, phase 5d).
 *
 * Injuries, near misses, dangerous occurrences, ill health and damage. Injury
 * details are health data (UK GDPR special category), so:
 *  - anyone on site reports through /accident-report and afterwards sees
 *    only the reports they made (/accident-report/mine, a summary);
 *  - full entries are read and investigated at /accidents by admins and
 *    Health & Safety at approve or above;
 *  - the model is in no permission group and has no generic CRUD grant, so
 *    the generic pages stay admin-only;
 *  - the audit trail records changes to the health fields as "[redacted]",
 *    and single-record reads are logged (auditPlugin).
 */
export const ACCIDENT_CATEGORIES = ['Injury', 'Near miss', 'Dangerous occurrence', 'Ill health', 'Property damage'];
export const ACCIDENT_TREATMENT = ['None', 'First aid on site', 'GP or walk-in centre', 'Hospital', 'Not known'];
export const ACCIDENT_STATUSES = ['Open', 'Investigating', 'Closed'];
// Fields that describe a person's health: kept out of the audit trail.
export const HEALTH_FIELDS = ['personName', 'injuryDetails', 'bodyPart', 'firstAid', 'treatment', 'description', 'investigation'];

const accidentReportSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  // ── When and where ──────────────────────────────────────────────────
  occurredAt: { type: Date, required: true },
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract', default: null },
  location: { type: String, trim: true, maxlength: 200 },
  category: { type: String, enum: ACCIDENT_CATEGORIES, required: true },

  // ── Who was hurt (none for a near miss or damage) ───────────────────
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
  subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier', default: null },
  personName: { type: String, trim: true, maxlength: 120 }, // anyone else, e.g. a member of the public

  // ── What happened ───────────────────────────────────────────────────
  description: { type: String, required: true, trim: true, maxlength: 4000 },
  injuryDetails: { type: String, trim: true, maxlength: 2000 },
  bodyPart: { type: String, trim: true, maxlength: 120 },
  firstAid: { type: String, trim: true, maxlength: 1000 },
  treatment: { type: String, enum: ACCIDENT_TREATMENT, default: 'Not known' },
  witnesses: { type: String, trim: true, maxlength: 1000 },
  immediateAction: { type: String, trim: true, maxlength: 2000 },

  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },

  // ── Investigation (Health & Safety) ─────────────────────────────────
  status: { type: String, enum: ACCIDENT_STATUSES, default: 'Open' },
  riddorReportable: { type: Boolean, default: null }, // null = not decided yet
  riddorReference: { type: String, trim: true, maxlength: 60 },
  riddorReportedDate: { type: Date, default: null },
  investigation: { type: String, trim: true, maxlength: 4000 },
  actions: { type: String, trim: true, maxlength: 4000 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  closedAt: { type: Date, default: null },
}, {
  timestamps: true,
});
accidentReportSchema.set('auditRedact', HEALTH_FIELDS);

accidentReportSchema.pre('validate', function (next) {
  if (this.employeeId && this.subcontractorId) {
    return next(new Error('Choose the employee or the subcontractor who was hurt, not both.'));
  }
  if (!this.contractId && !this.location) {
    return next(new Error('Say where it happened: choose the site or describe the place.'));
  }
  if (this.occurredAt && this.occurredAt > new Date(Date.now() + 5 * 60 * 1000)) {
    return next(new Error('When it happened is in the future.'));
  }
  if (this.status === 'Closed' && !this.closedAt) this.closedAt = new Date();
  if (this.status !== 'Closed') this.closedAt = null;
  next();
});

accidentReportSchema.index({ occurredAt: -1 });
accidentReportSchema.index({ reportedBy: 1, occurredAt: -1 });
accidentReportSchema.index({ status: 1 });
accidentReportSchema.index({ contractId: 1 });

export default {
  modelName: 'accidentReport',
  schema: accidentReportSchema,
};
