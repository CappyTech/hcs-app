import mongoose from 'mongoose';

/**
 * The app icon an admin uploaded on Admin → Branding (a single document).
 *
 * `data` is always a 512×512 PNG: brandService.normaliseUpload re-encodes
 * every upload before it is stored, so nothing but pixels is ever kept or
 * served. With no document, brandService draws a neutral mark in the brand
 * colour instead.
 *
 * The bytes live in the database, not the container, so they survive a
 * redeploy. Excluded from the audit trail (see AUDIT_EXCLUDE_MODELS): the
 * diff would be a binary blob; the change itself is logged by the controller.
 */
const appIconSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'global', unique: true, immutable: true },
    data: { type: Buffer, required: true },
    mime: { type: String, default: 'image/png' },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

export default { modelName: 'appIcon', schema: appIconSchema };
