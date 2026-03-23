const mongoose = require('mongoose');
const { note, uuidField } = require('@cappytech/hcs-schemas');

const noteSchema = new mongoose.Schema({
  uuid: uuidField,
  ...note.fields,
}, { timestamps: true });

note.indexes.forEach(idx => noteSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'note',
  schema: noteSchema
};
