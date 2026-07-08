const mongoose = require('mongoose');
const { bankAccount, uuidField } = require('@cappytech/hcs-schemas');

const bankAccountSchema = new mongoose.Schema({
  uuid: uuidField,
  ...bankAccount.fields,
}, { timestamps: true });

bankAccount.indexes.forEach(idx => bankAccountSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'bankAccount',
  schema: bankAccountSchema
};
