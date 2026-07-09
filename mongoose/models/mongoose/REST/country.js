const mongoose = require('mongoose');
const { country, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const countrySchema = new mongoose.Schema({
  uuid: uuidField,
  ...country.fields,
}, { timestamps: true, strict: false });

country.indexes.forEach(idx => countrySchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'country',
  schema: countrySchema
};
