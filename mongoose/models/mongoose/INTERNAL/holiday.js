const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const holidaySchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  title: { type: String, required: true },
  date: { type: String, required: true }, // Store as string for YYYY-MM-DD comparison
  notes: { type: String },
  bunting: { type: Boolean, required: true },
  division: { type: String, required: true }
}, {
  timestamps: true
});

holidaySchema.index({ title: 1, date: 1, division: 1 }, { unique: true });

module.exports = {
  modelName: 'holiday',
  schema: holidaySchema
};
