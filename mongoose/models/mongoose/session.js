const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const sessionSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  _id: { type: String },
  expires: { type: Date, required: true },
  session: { type: mongoose.Schema.Types.Mixed, required: true }
}, { collection: 'sessions', minimize: false });

module.exports = mongoose.model('session', sessionSchema);
