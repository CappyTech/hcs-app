const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema({
  title: { type: String, required: true },
  date: { type: String, required: true }, // Store as string for YYYY-MM-DD comparison
  notes: { type: String },
  bunting: { type: Boolean, required: true },
  division: { type: String, required: true }
}, {
  timestamps: true
});

module.exports = mongoose.model('holiday', holidaySchema);
