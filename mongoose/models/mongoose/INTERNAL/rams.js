import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * RAMS — risk assessment and method statement (Health & Safety, phase 5c).
 *
 * One per piece of work on a site (a contract). Health & Safety writes and
 * approves them through the generic pages; only an Approved RAMS can be
 * briefed (ramsBriefing, recorded on /rams/brief). `reviewDate` is when it
 * must be looked at again; healthSafetyComplianceService reminds before it.
 */
export const RAMS_STATUSES = ['Draft', 'Approved', 'Superseded'];
export const RAMS_PPE = [
  'Safety boots', 'Hi-vis', 'Hard hat', 'Gloves', 'Eye protection',
  'Hearing protection', 'Dust mask / RPE', 'Chainsaw PPE', 'Harness',
];

const ramsSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract', required: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  reference: { type: String, trim: true, maxlength: 60 },
  version: { type: Number, default: 1, min: 1 },
  status: { type: String, enum: RAMS_STATUSES, default: 'Draft' },

  // ── The assessment ──────────────────────────────────────────────────
  scope: { type: String, trim: true, maxlength: 4000 },     // the work it covers
  hazards: { type: String, trim: true, maxlength: 4000 },
  controls: { type: String, trim: true, maxlength: 4000 },  // control measures and method
  ppe: [{ type: String, enum: RAMS_PPE }],
  // Where the full signed document lives, if it is kept elsewhere.
  documentUrl: { type: String, trim: true, maxlength: 500 },

  // ── Sign-off ────────────────────────────────────────────────────────
  preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  approvedDate: { type: Date, default: null },
  reviewDate: { type: Date, default: null },

  notes: { type: String, trim: true, maxlength: 2000 },
}, {
  timestamps: true,
});

ramsSchema.pre('validate', function (next) {
  if (this.documentUrl && !/^https?:\/\//i.test(this.documentUrl)) {
    return next(new Error('The document link must start with http:// or https://.'));
  }
  if (this.status === 'Approved' && !this.approvedDate) this.approvedDate = new Date();
  next();
});

ramsSchema.index({ contractId: 1, status: 1 });
ramsSchema.index({ reviewDate: 1 });

export default {
  modelName: 'rams',
  schema: ramsSchema,
};
