'use strict';

const mongoose = require('mongoose');

/**
 * Platform-wide email branding (a single, admin-managed document).
 *
 * Holds the branded header and footer wrapped around every outgoing email by
 * notificationService.enqueue. Each block has its own on/off switch, and an
 * individual emailType may opt out via its `useGlobalHeader` / `useGlobalFooter`
 * flags. This branding footer sits ABOVE the mandatory unsubscribe footer
 * (which is legally required and always present) — it is for logos, contact
 * details, address, social links, etc.
 *
 * `singleton` is a fixed sentinel with a unique index so there is always at
 * most one document; emailBrandingService reads/upserts on that key.
 *
 * `headerHtml` / `footerHtml` are raw HTML authored by an admin (a trusted
 * role) and rendered verbatim into the email, so they may contain <img>, <a>,
 * inline styles, etc. They are never populated from untrusted input.
 */
const emailBrandingSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'global', unique: true, immutable: true },

    headerEnabled: { type: Boolean, default: false },
    headerHtml:    { type: String, default: '', maxlength: 20000 },

    footerEnabled: { type: Boolean, default: false },
    footerHtml:    { type: String, default: '', maxlength: 20000 },
  },
  { timestamps: true },
);

module.exports = { modelName: 'emailBranding', schema: emailBrandingSchema };
