const mongoose = require('mongoose');
const { accountingPeriod, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const accountingPeriodSchema = new mongoose.Schema({
  uuid: uuidField,
  ...accountingPeriod.fields,
}, { timestamps: true, strict: false });

accountingPeriod.indexes.forEach(idx => accountingPeriodSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'accountingPeriod',
  schema: accountingPeriodSchema
};
