'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Notification outbox.
 *
 * Features enqueue notifications here instead of calling the email service
 * directly; the notification-outbox job delivers them with retry/backoff so
 * an SMTP outage never loses a message. `dedupeKey` lets recurring reminder
 * jobs enqueue idempotently (e.g. 'cis-return-2026-06-user@x.com').
 */

const STATUSES = ['pending', 'sent', 'failed', 'cancelled'];

const notificationSchema = new mongoose.Schema(
  {
    uuid: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomUUID(),
    },

    channel: { type: String, enum: ['email'], default: 'email' },

    to:      { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    html:    { type: String },
    text:    { type: String },

    // Originating feature, for filtering/reporting: 'holiday', 'cis', 'fleet',
    // 'gdpr', 'security', 'system', …
    category: { type: String, default: 'system', index: true },

    // Loose reference back to the triggering record
    refType: { type: String, default: null },
    refId:   { type: String, default: null },

    // Idempotency key — enqueue() skips inserts when a notification with the
    // same key already exists (any status)
    dedupeKey: { type: String, default: null, index: true },

    status:        { type: String, enum: STATUSES, default: 'pending', index: true },
    attempts:      { type: Number, default: 0 },
    maxAttempts:   { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError:     { type: String, default: null },
    sentAt:        { type: Date, default: null },
  },
  { timestamps: true },
);

// Worker query: pending notifications that are due
notificationSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = { modelName: 'notification', schema: notificationSchema };
