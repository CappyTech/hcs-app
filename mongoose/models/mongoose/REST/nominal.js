const mongoose = require('mongoose');
const { nominal, uuidField } = require('@cappytech/hcs-schemas');

const nominalSchema = new mongoose.Schema({
  uuid: uuidField,
  ...nominal.fields,
}, { timestamps: true });

nominal.indexes.forEach(idx => nominalSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'nominal',
  schema: nominalSchema
};