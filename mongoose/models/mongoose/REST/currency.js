const mongoose = require('mongoose');
const { currency, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const currencySchema = new mongoose.Schema({
  uuid: uuidField,
  ...currency.fields,
}, { timestamps: true, strict: false });

currency.indexes.forEach(idx => currencySchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'currency',
  schema: currencySchema
};
