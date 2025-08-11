const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const metaSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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

module.exports = {
  modelName: 'meta',
  schema: metaSchema
};