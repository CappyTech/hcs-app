const mongoose = require('mongoose');
const { vatRate, uuidField } = require('@cappytech/hcs-schemas');

const vatRateSchema = new mongoose.Schema({
  uuid: uuidField,
  ...vatRate.fields,
}, {
  collection: vatRate.collection,
  strict: false,
  timestamps: true,
});

vatRate.indexes.forEach(idx => vatRateSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'vatrate',
  schema: vatRateSchema,
};
