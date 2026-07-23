import mongoose from 'mongoose';
import crypto from 'crypto';

const holidayCustomSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  title: { type: String, required: true },
  date: { type: Date, required: true },
  notes: { type: String }
}, {
  timestamps: true
});

export default {
  modelName: 'holidayCustom',
  schema: holidayCustomSchema
};
