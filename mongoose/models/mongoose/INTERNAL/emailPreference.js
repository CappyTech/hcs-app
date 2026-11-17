import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * Per-user subscription state for a single emailType.
 *
 * A row exists only once a user has explicitly toggled a type. Absence of a
 * row means "use the type's defaultOn" (see emailPreferenceService.isSubscribed),
 * so we never have to backfill preferences when a new emailType is added.
 *
 * Channels: `subscribed` is the EMAIL channel (its meaning predates SMS and
 * in-app, and existing rows keep it unchanged — no migration). `sms` and
 * `inApp` hold the person's choice for those channels; unset (undefined) means
 * "use the type's smsDefaultOn / inAppDefaultOn". Likewise a row created only
 * to record an SMS or in-app choice leaves `subscribed` unset, so email keeps
 * following the type's defaultOn.
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

    // Email channel. Optional so a row can carry only an SMS / in-app choice.
    subscribed: { type: Boolean },

    // SMS and in-app channels; unset = the type's default.
    sms:   { type: Boolean },
    inApp: { type: Boolean },
  },
  { timestamps: true },
);

// One preference per (user, type).
emailPreferenceSchema.index({ userId: 1, typeKey: 1 }, { unique: true });

export default { modelName: 'emailPreference', schema: emailPreferenceSchema };
