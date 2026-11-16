import mongoose from 'mongoose';
import crypto from 'crypto';

// An uploaded workbook, parsed and waiting for the import to be confirmed.
//
// The upload page reads the .xlsx once and keeps what it found here, so the
// preview (and, for the weekly sheet, the name and site mapping) can be
// checked before anything is written. Nothing reads this after the import;
// documents expire after a day whether they were used or not.
const KINDS = ['jobRegister', 'weeklySheet'];

const workbookImportSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  kind: { type: String, enum: KINDS, required: true },
  fileName: { type: String, trim: true, maxlength: 255 },
  // What the parser found (shape depends on kind)
  parsed: { type: mongoose.Schema.Types.Mixed, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  // Set once the import has run, with its counts
  importedAt: { type: Date },
  result: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
}, { minimize: false });

export default {
  modelName: 'workbookImport',
  schema: workbookImportSchema,
};
