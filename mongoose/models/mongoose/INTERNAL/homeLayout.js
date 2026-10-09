import mongoose from 'mongoose';

/**
 * What a home page shows: pinned overview areas, figures and lists.
 *
 * scope 'user' is one person's own layout (key = their user _id); scope 'role'
 * is the starting layout for everyone with that role who hasn't made their own
 * (key = role name). With neither, home shows every area the person may open.
 *
 * Pins are references into the overview hierarchy (config/overviews):
 *   areas   — area ids ('human')
 *   figures — figure refs ('employee.rtwDue')
 *   lists   — 'node:list:<figure ref or index>' or 'node:panel:<panel name>'
 * They are only references: every pin is checked against the viewer's
 * permissions when home is drawn, so a stored pin never shows anything the
 * person couldn't open themselves. Pins that no longer exist are skipped.
 */
const PIN = /^[A-Za-z0-9_.:-]{1,160}$/;
const pins = { type: [{ type: String, match: PIN }], default: [] };

const homeLayoutSchema = new mongoose.Schema({
  scope: { type: String, enum: ['user', 'role'], required: true },
  key: { type: String, required: true, trim: true, maxlength: 64 },
  areas: pins,
  figures: pins,
  lists: pins,
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, {
  timestamps: true,
});

homeLayoutSchema.index({ scope: 1, key: 1 }, { unique: true });

export default {
  modelName: 'homeLayout',
  schema: homeLayoutSchema,
};
