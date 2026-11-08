import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * RAMS briefing (Health & Safety, phase 5c): one person was briefed on an
 * approved RAMS and signed to say they understood it. `contractId` copies the
 * RAMS's site so a project-scoped grant can filter on it. Recorded on
 * /rams/brief (Site Managers and Supervisors on their own sites).
 */
const ramsBriefingSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  ramsId: { type: mongoose.Schema.Types.ObjectId, ref: 'rams', required: true },
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract', required: true },
  ramsVersion: { type: Number, default: 1 },

  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
  subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier', default: null },
  personName: { type: String, trim: true, maxlength: 120 },

  date: { type: Date, required: true },
  briefedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
  notes: { type: String, trim: true, maxlength: 1000 },
}, {
  timestamps: true,
});

ramsBriefingSchema.pre('validate', function (next) {
  if (this.employeeId && this.subcontractorId) {
    return next(new Error('A briefing is for an employee or a subcontractor, not both.'));
  }
  if (!this.employeeId && !this.subcontractorId) {
    return next(new Error('Choose the employee or subcontractor who was briefed.'));
  }
  next();
});

ramsBriefingSchema.index({ ramsId: 1, date: -1 });
ramsBriefingSchema.index({ contractId: 1 });
ramsBriefingSchema.index({ employeeId: 1 });
ramsBriefingSchema.index({ subcontractorId: 1 });

export default {
  modelName: 'ramsBriefing',
  schema: ramsBriefingSchema,
};
