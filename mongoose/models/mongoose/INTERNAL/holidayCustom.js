const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const holidayCustomSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
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
