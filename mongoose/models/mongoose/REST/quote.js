const mongoose = require('mongoose');
const { quote, uuidField } = require('@cappytech/hcs-schemas');

const quoteSchema = new mongoose.Schema({
  uuid: uuidField,
  ...quote.fields,
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

quote.indexes.forEach(idx => quoteSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'quote',
  schema: quoteSchema
};