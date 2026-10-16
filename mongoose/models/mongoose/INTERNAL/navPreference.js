import mongoose from 'mongoose';

/**
 * One person's navigation preference: which header layout they see and, for
 * the command rail, which departments are pinned to it.
 *
 * A person without a document gets the company default (NAV_STYLE_DEFAULT at
 * /admin/config → Appearance), and 'tabs' when that is unset too. Pinned
 * slugs are only references into departmentsConfig: navigationService drops
 * any the person may not open, so a stored pin never shows a department they
 * couldn't reach.
 */
const SLUG = /^[a-z0-9-]{1,64}$/;

const navPreferenceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, unique: true },
  navStyle: { type: String, enum: ['tabs', 'grouped', 'two-tier', 'command', 'sidebar'], default: 'tabs' },
  // null = the person has never chosen, so the defaults apply
  pinned: { type: [{ type: String, match: SLUG }], default: null },
}, {
  timestamps: true,
});

export default {
  modelName: 'navPreference',
  schema: navPreferenceSchema,
};
