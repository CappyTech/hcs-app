const mongoose = require('mongoose');
const { invoice, uuidField } = require('@cappytech/hcs-schemas');

const invoiceSchema = new mongoose.Schema({
  uuid: uuidField,
  ...invoice.fields,
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

invoice.indexes.forEach(idx => invoiceSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'invoice',
  schema: invoiceSchema
};