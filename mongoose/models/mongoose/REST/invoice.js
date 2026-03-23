const mongoose = require('mongoose');
const { invoice, uuidField } = require('@cappytech/hcs-schemas');

const invoiceSchema = new mongoose.Schema({
  uuid: uuidField,
  ...invoice.fields,
}, { timestamps: true });

invoice.indexes.forEach(idx => invoiceSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'invoice',
  schema: invoiceSchema
};