const mongoose = require('mongoose');
const crypto = require('crypto');

const sessionSchema = new mongoose.Schema({
  _id: { type: String },
  expires: { type: Date, required: true },
  session: { type: mongoose.Schema.Types.Mixed, required: true },
  // Denormalized user id for efficient lookup (added post-deployment)
  userId: { type: String, index: true },
  // Additional denormalized fields to avoid decrypting session payload
  username: { type: String },
  email: { type: String },
  role: { type: String },
  ip: { type: String },
  uaBrowser: { type: String },
  uaVersion: { type: String },
  uaOS: { type: String },
  loginTime: { type: Date }
}, { collection: 'sessions', minimize: false });

// Compound index to optimize lookups of active sessions per user and allow efficient expiry scans
sessionSchema.index({ userId: 1, expires: 1 });
// Track recent activity (optional display / idle detection)
sessionSchema.add({ lastActivity: { type: Date, index: true } });

module.exports = {
  modelName: 'session',
  schema: sessionSchema
};
