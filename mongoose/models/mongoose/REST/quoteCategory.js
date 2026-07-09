const mongoose = require('mongoose');
const { quoteCategory, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const quoteCategorySchema = new mongoose.Schema({
  uuid: uuidField,
  ...quoteCategory.fields,
}, { timestamps: true, strict: false });

quoteCategory.indexes.forEach(idx => quoteCategorySchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'quoteCategory',
  schema: quoteCategorySchema
};
