'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Per-user subscription state for a single emailType.
 *
 * A row exists only once a user has explicitly toggled a type. Absence of a
 * row means "use the type's defaultOn" (see emailPreferenceService.isSubscribed),
 * so we never have to backfill preferences when a new emailType is added.
 */

const emailPreferenceSchema = new mongoose.Schema(
  {
    uuid: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomUUID(),
    },

    // Stored as string to match how notification.recipientUserId / callers pass ids.
    userId: { type: String, required: true, index: true },

    // emailType.key this preference applies to.
    typeKey: { type: String, required: true, trim: true, lowercase: true },

    subscribed: { type: Boolean, required: true },
  },
  { timestamps: true },
);

// One preference per (user, type).
emailPreferenceSchema.index({ userId: 1, typeKey: 1 }, { unique: true });

module.exports = { modelName: 'emailPreference', schema: emailPreferenceSchema };
