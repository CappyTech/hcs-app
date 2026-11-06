import mongoose from 'mongoose';

/**
 * One person's page layout preference: how wide the main content runs.
 *
 * A person without a document gets the company default (CONTENT_WIDTH_DEFAULT
 * at /admin/config → Appearance), and 'standard' when that is unset too.
 */
const layoutPreferenceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, unique: true },
  contentWidth: { type: String, enum: ['narrow', 'standard', 'wide', 'full'], required: true },
}, {
  timestamps: true,
});

export default {
  modelName: 'layoutPreference',
  schema: layoutPreferenceSchema,
};
