import mongoose from 'mongoose';

/**
 * A company's change to one job role (docs/PERMISSION-GROUPS.md, phase 4).
 *
 * The job roles in accessGroupsConfig.js are the shipped defaults. Each
 * document here is the whole definition of one role as the company wants it:
 * a built-in role it has changed or turned off, or a role it added
 * (`custom: true`, no code default). Deleting a built-in role's document is
 * "Reset to default". jobRoleConfigService validates every definition before
 * it's stored and applies it straight away. Changes are recorded by the audit
 * plugin like any INTERNAL model.
 */
const grantSchema = new mongoose.Schema({
  group: { type: String, required: true },
  level: { type: String, enum: ['view', 'edit', 'approve', 'manage'], required: true },
  scope: { type: String, enum: ['all', 'project'], default: 'all' },
  values: { type: Boolean, default: false },
}, { _id: false });

const jobRoleConfigSchema = new mongoose.Schema({
  slug: { type: String, required: true, trim: true, match: /^[a-z][A-Za-z0-9]{1,39}$/ },
  custom: { type: Boolean, default: false },
  label: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
  values: { type: String, enum: ['always', 'never', 'flag'], required: true },
  grants: { type: [grantSchema], default: [] },
  disabled: { type: Boolean, default: false },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, {
  timestamps: true,
});

jobRoleConfigSchema.index({ slug: 1 }, { unique: true });

export default {
  modelName: 'jobRoleConfig',
  schema: jobRoleConfigSchema,
};
