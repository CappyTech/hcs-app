import mongoose from 'mongoose';
import crypto from 'crypto';

// An uploaded workbook, parsed and waiting for the import to be confirmed.
//
// The upload page reads the .xlsx once and keeps what it found here, so the
// preview (and, for the weekly sheet, the name and site mapping) can be
// checked before anything is written.
//
// An upload expires a day after it's made (expiresAt, a TTL index), unless
// it's saved: saving keeps the choices made on its check page (choices) and
// clears expiresAt, so it stays until it's imported or deleted. Once
// imported it expires a day later again.
const KINDS = ['jobRegister', 'weeklySheet'];
export const UPLOAD_LIFETIME_MS = 864e5;

const workbookImportSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  kind: { type: String, enum: KINDS, required: true },
  fileName: { type: String, trim: true, maxlength: 255 },
  // What the parser found (shape depends on kind)
  parsed: { type: mongoose.Schema.Types.Mixed, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  createdAt: { type: Date, default: Date.now },
  // Removed by the TTL index once past; unset while saved
  expiresAt: { type: Date, default: () => new Date(Date.now() + UPLOAD_LIFETIME_MS) },

  // Saved for later: the check page's choices, kept until imported or deleted.
  //   jobRegister: { pairs: ['quoteNumber:projectNumber', …] }  (ticked pairs)
  //   weeklySheet: { person: { [index]: 'e:<id>' | 's:<id>' | '' },
  //                  place:  { [index]: 'con:<id>' | 'loc:<id>' | 'new' | '' } }
  saved: { type: Boolean, default: false },
  savedAt: { type: Date },
  savedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  choices: { type: mongoose.Schema.Types.Mixed },

  // Set once the import has run, with its counts
  importedAt: { type: Date },
  result: { type: mongoose.Schema.Types.Mixed },
}, { minimize: false });

workbookImportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
workbookImportSchema.index({ kind: 1, createdAt: -1 });

export default {
  modelName: 'workbookImport',
  schema: workbookImportSchema,
};
