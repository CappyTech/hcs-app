import mongoose from 'mongoose';
import crypto from 'crypto';

const holidaySchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  title: { type: String, required: true },
  date: { type: String, required: true }, // Store as string for YYYY-MM-DD comparison
  notes: { type: String },
  bunting: { type: Boolean, required: true },
  division: { type: String, required: true }
}, {
  timestamps: true
});

holidaySchema.index({ title: 1, date: 1, division: 1 }, { unique: true });

export default {
  modelName: 'holiday',
  schema: holidaySchema
};
