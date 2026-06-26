'use strict';

const mongoose = require('mongoose');

// Append-only audit trail of INTERNAL database operations. Written by the
// global audit plugin (mongoose/services/auditPlugin.js); never edited in place.
const auditLogSchema = new mongoose.Schema({
  // ── What ──────────────────────────────────────────────────────────────────
  collectionName: { type: String, required: true, index: true }, // model name, e.g. "policyDocument"
  op:             { type: String, required: true, enum: ['create', 'update', 'delete', 'read'], index: true },
  docId:          { type: mongoose.Schema.Types.ObjectId, index: true },
  docUuid:        { type: String, index: true }, // when the model carries a uuid

  // ── Who (snapshotted so attribution survives the actor being deleted) ───────
  actor:          { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null, index: true },
  actorName:      { type: String, default: '' },
  actorEmail:     { type: String, default: '' },

  // ── Request context ─────────────────────────────────────────────────────────
  ip:             { type: String, default: '' },
  method:         { type: String, default: '' },
  route:          { type: String, default: '' },

  // ── Change detail (writes only) ─────────────────────────────────────────────
  before:         { type: mongoose.Schema.Types.Mixed },              // pre-image (update/delete)
  after:          { type: mongoose.Schema.Types.Mixed },              // post-image (create/update)
  changes:        { type: mongoose.Schema.Types.Mixed },              // { field: { from, to } }
}, {
  // Entries are immutable; `at` is the creation time, no updatedAt.
  timestamps: { createdAt: 'at', updatedAt: false },
  minimize: false,
});

// Common query patterns: history of one document, and recent-first scans.
auditLogSchema.index({ collectionName: 1, docId: 1, at: -1 });
auditLogSchema.index({ at: -1 });

// Optional retention: set AUDIT_TTL_DAYS>0 to auto-expire old entries.
// Unset/0 keeps the trail indefinitely (the default for an audit log).
const ttlDays = parseInt(process.env.AUDIT_TTL_DAYS, 10);
if (Number.isFinite(ttlDays) && ttlDays > 0) {
  auditLogSchema.index({ at: 1 }, { expireAfterSeconds: ttlDays * 86400 });
}

module.exports = {
  modelName: 'auditLog',
  schema: auditLogSchema,
};
