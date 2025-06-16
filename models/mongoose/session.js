const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const sessionSchema = new Schema({
  sid: { type: String, required: true, unique: true },
  session: { type: Object, required: true },
  expires: { type: Date, required: true }
}, {
  timestamps: true,
  collection: 'sessions'
});

module.exports = mongoose.model('session', sessionSchema);
