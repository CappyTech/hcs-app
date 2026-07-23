import mongoose from 'mongoose';
import crypto from 'crypto';

const metaSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  model: {
    type: String,
    required: true,
    unique: true,
  },
  createdCount: {
    type: Number,
    default: 0,
  },
  updatedCount: {
    type: Number,
    default: 0,
  },
  checkedCount: {
    type: Number,
    default: 0,
  },
  lastFetchedAt: {
    type: Date,
    default: null,
  }
}, {
  timestamps: true
});

export default {
  modelName: 'meta',
  schema: metaSchema
};