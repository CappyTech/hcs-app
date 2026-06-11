'use strict';

const mongoose = require('mongoose');

/**
 * Security audit trail — authentication and account-security events, kept
 * separate from the application log so they survive log rotation and can be
 * reviewed/filtered at /admin/security-events.
 * Documents expire automatically after 400 days (~13 months) to bound growth
 * while covering an annual audit cycle.
 */

const EVENT_TYPES = [
  'login_success',
  'login_failed',
  'account_locked',
  'logout',
  'password_changed',
  'password_reset_requested',
  'password_reset_completed',
  'totp_enabled',
  'totp_disabled',
  'backup_codes_regenerated',
  'role_changed',
  'email_changed',
  'sso_token_issued',
  'sso_token_denied',
];

const securityEventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: EVENT_TYPES, required: true, index: true },

    // Who the event concerns (may be null for failed logins of unknown users)
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null, index: true },
    username: { type: String, trim: true, default: null },

    // Who performed it, when different (e.g. admin changing a user's role)
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    actorName: { type: String, trim: true, default: null },

    ip:        { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 300 },

    // Event-specific details (old/new role, lockout count, …) — never secrets
    meta: { type: Object, default: {} },

    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);

// Auto-expire after ~13 months
securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });
securityEventSchema.index({ type: 1, createdAt: -1 });

module.exports = { modelName: 'securityEvent', schema: securityEventSchema };
