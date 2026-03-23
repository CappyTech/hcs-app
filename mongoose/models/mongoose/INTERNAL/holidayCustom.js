const mongoose = require('mongoose');
const crypto = require('crypto');

const holidayCustomSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  title: { type: String, required: true },
  date: { type: Date, required: true },
  notes: { type: String }
}, {
  timestamps: true
});

module.exports = {
  modelName: 'holidayCustom',
  schema: holidayCustomSchema
};
