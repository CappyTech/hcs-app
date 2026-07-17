'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Email/notification type catalog (DB-driven).
 *
 * Every email the platform can send maps to a `key` here. Admins manage the
 * catalog from /admin/emails/types: add new types, edit copy, enable/disable,
 * or delete (non-core types only). Senders reference the stable `key`; if a
 * caller ever fires an unknown key, emailTypeService.resolveOrRegister creates
 * a DISABLED stub so the type surfaces in the admin UI instead of being lost.
 *
 * `senderType` drives the unsubscribe footer semantics rendered by
 * notificationService.buildFooter:
 *   - system  → "system notification email" (subscribable ⇒ unsubscribe link)
 *   - admin   → subscribable ⇒ "admin notification email" (unsubscribe link);
 *               non-subscribable ⇒ "sent by an admin, you cannot unsubscribe"
 */

const SENDER_TYPES = ['system', 'admin'];

const emailTypeSchema = new mongoose.Schema(
  {
    uuid: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomUUID(),
    },

    // Stable kebab-case identifier used by sending code (e.g. 'task-assigned').
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Key must be kebab-case (lowercase letters, digits, hyphens).'],
      maxlength: 60,
    },

    label:       { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', trim: true, maxlength: 500 },

    senderType: { type: String, enum: SENDER_TYPES, default: 'system', index: true },

    // Whether recipients may unsubscribe. Mandatory types (e.g. security) = false.
    subscribable: { type: Boolean, default: true },

    // Default subscription state when a user has no explicit emailPreference.
    defaultOn: { type: Boolean, default: true },

    // Master switch: a disabled type never sends.
    enabled: { type: Boolean, default: true, index: true },

    // Core types are seeded because code depends on them: the UI may disable
    // but never delete them.
    isCore: { type: Boolean, default: false },

    // "What the email looks like" overrides used by the preview and by
    // admin-composed messages of this type. `heading` sets the H2 at the top of
    // the email body (falls back to the type label / message subject); `intro`
    // is an opening paragraph shown before the body.
    heading: { type: String, default: '', trim: true, maxlength: 120 },
    intro:   { type: String, default: '', trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

module.exports = { modelName: 'emailType', schema: emailTypeSchema, SENDER_TYPES };
