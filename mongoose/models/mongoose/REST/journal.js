import mongoose from 'mongoose';
import { journal, uuidField } from '@cappytech/hcs-schemas';

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const journalSchema = new mongoose.Schema({
  uuid: uuidField,
  ...journal.fields,
}, { timestamps: true, strict: false });

journal.indexes.forEach(idx => journalSchema.index(idx.fields, idx.options));

export default {
  modelName: 'journal',
  schema: journalSchema
};
