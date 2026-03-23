const mongoose = require('mongoose');
const { customer, uuidField } = require('@cappytech/hcs-schemas');

const customerSchema = new mongoose.Schema({
  uuid: uuidField,
  ...customer.fields,
}, { timestamps: true });

customer.indexes.forEach(idx => customerSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'customer',
  schema: customerSchema
};