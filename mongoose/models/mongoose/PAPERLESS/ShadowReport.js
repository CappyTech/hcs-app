// mongoose/models/mongoose/PAPERLESS/ShadowReport.js
//
// One saved comparison per day of what hcs-app would have sent against what
// Paperless actually sent (Paperless migration H8). Saved daily so the week of
// shadow running before cutover can be read back as it was, rather than
// recomputed from tags that have moved on since.
import mongoose from 'mongoose';

const ShadowReportSchema = new mongoose.Schema({
  day: { type: String, required: true, unique: true }, // YYYY-MM-DD (UTC), the day compared
  from: Date,
  to: Date,
  clean: { type: Boolean, default: false, index: true },
  mode: { type: String, default: null },
  totals: { type: mongoose.Schema.Types.Mixed, default: {} },
  kinds: { type: mongoose.Schema.Types.Mixed, default: {} },
  generatedAt: Date,
}, { timestamps: true });

export default {
  modelName: 'ShadowReport',
  schema: ShadowReportSchema,
};
