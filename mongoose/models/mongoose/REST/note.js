import mongoose from 'mongoose';
import { note, uuidField } from '@cappytech/hcs-schemas';

const noteSchema = new mongoose.Schema({
  uuid: uuidField,
  ...note.fields,
}, { timestamps: true });

note.indexes.forEach(idx => noteSchema.index(idx.fields, idx.options));

export default {
  modelName: 'note',
  schema: noteSchema
};
