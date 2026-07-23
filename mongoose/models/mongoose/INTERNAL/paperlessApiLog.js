import mongoose from 'mongoose';

const paperlessApiLogSchema = new mongoose.Schema({
  direction: { type: String, enum: ['request', 'response', 'error'], required: true, index: true },
  method:    { type: String, uppercase: true },
  url:       { type: String },
  status:    { type: Number, index: true },
  // Authorization token is never stored
  requestBody:  { type: mongoose.Schema.Types.Mixed },
  responseBody: { type: mongoose.Schema.Types.Mixed },
  errorMessage: { type: String },
  durationMs:   { type: Number },
}, {
  timestamps: true,
  capped: { size: 50 * 1024 * 1024, max: 10000 }, // 50 MB / 10 k docs rolling window
});

export default { modelName: 'paperlessApiLog', schema: paperlessApiLogSchema };
