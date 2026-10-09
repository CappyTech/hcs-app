import mongoose from 'mongoose';

/**
 * A company's changes to the overview hierarchy (config/overviews).
 *
 * The definitions in code are the shipped defaults; each document here holds
 * one area's or node's override, merged on top at startup and after every save
 * (overviewConfigService). Deleting a document is "Reset to default". A
 * `custom` document is an area or node that exists only here (no code default),
 * so its override is the whole definition.
 *
 * Every override is validated before it's stored: fields must exist on the
 * model, filter operators come from a fixed list, and nothing that runs code is
 * accepted. Changes are recorded by the audit plugin like any INTERNAL model.
 */
const overviewConfigSchema = new mongoose.Schema({
  kind: { type: String, enum: ['area', 'node'], required: true },
  key: { type: String, required: true, trim: true, match: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ },
  custom: { type: Boolean, default: false },
  override: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, {
  timestamps: true,
  minimize: false,
});

overviewConfigSchema.index({ kind: 1, key: 1 }, { unique: true });

export default {
  modelName: 'overviewConfig',
  schema: overviewConfigSchema,
};
