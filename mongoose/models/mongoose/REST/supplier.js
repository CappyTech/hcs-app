const mongoose = require('mongoose');
const { supplier, uuidField } = require('@cappytech/hcs-schemas');

const supplierSchema = new mongoose.Schema({
  uuid: uuidField,
  ...supplier.fields,
}, { timestamps: true });

supplier.indexes.forEach(idx => supplierSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'supplier',
  schema: supplierSchema
};