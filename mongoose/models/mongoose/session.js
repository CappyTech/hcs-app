const mongoose = require('mongoose');
const { Schema } = mongoose;

const sessionSchema = new Schema({
  _id: { type: String },
  expires: { type: Date, required: true },
  session: { type: Schema.Types.Mixed, required: true }
}, { collection: 'sessions', minimize: false });

module.exports = mongoose.model('session', sessionSchema);
