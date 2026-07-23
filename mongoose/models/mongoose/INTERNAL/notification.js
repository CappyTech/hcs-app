import mongoose from 'mongoose';
import crypto from 'crypto';

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
    // 'gdpr', 'security', 'system', …  Kept as a synonym of typeKey for
    // back-compat with existing callers that only pass `category`.
    category: { type: String, default: 'system', index: true },

    // emailType.key this notification was sent under (null for ad-hoc sends).
    typeKey: { type: String, default: null, index: true },

    // Who sent it — drives the unsubscribe footer variant.
    senderType: { type: String, enum: ['system', 'admin', 'user'], default: 'system' },

    // Whether the recipient can unsubscribe from this notification.
    unsubscribable: { type: Boolean, default: false },

    // Recipient/sender user ids (string uuids or ObjectId strings), for the
    // dashboard, gating and footer link building.
    recipientUserId: { type: String, default: null },
    senderUserId:    { type: String, default: null },

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

export default { modelName: 'notification', schema: notificationSchema };
