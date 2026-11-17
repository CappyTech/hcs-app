import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * In-app notifications: the list a signed-in person sees at /notifications,
 * with the unread count on the bell in the header.
 *
 * Written by notifyService.notifyUsers (through inAppNotificationService) for
 * people whose preferences have the in-app channel on for that type. Unlike
 * email and SMS there is nothing to deliver, so these never pass through the
 * notification outbox. `dedupeKey` makes a repeated notifyUsers call for the
 * same notice a no-op.
 */

const inAppNotificationSchema = new mongoose.Schema(
  {
    uuid: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomUUID(),
    },

    // Recipient. Stored as a string, like emailPreference.userId and
    // notification.recipientUserId.
    userId: { type: String, required: true, index: true },

    // emailType.key the notice was sent under (e.g. 'attendance').
    typeKey: { type: String, default: null, trim: true, lowercase: true },

    title: { type: String, required: true, trim: true, maxlength: 300 },
    body:  { type: String, default: '', trim: true, maxlength: 5000 },

    // Where the notice points, as a path inside the app ('/attendance/…').
    // Only same-site paths are stored; see inAppNotificationService.safeLink.
    link: { type: String, default: null, trim: true, maxlength: 500 },

    // null while unread.
    readAt: { type: Date, default: null },

    dedupeKey: { type: String, default: null, index: true },
  },
  { timestamps: true },
);

// The list (newest first) and the unread count are both per-user queries.
inAppNotificationSchema.index({ userId: 1, createdAt: -1 });
inAppNotificationSchema.index({ userId: 1, readAt: 1 });

export default { modelName: 'inAppNotification', schema: inAppNotificationSchema };
