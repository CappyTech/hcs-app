import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { nominal, uuidField } = schemas;

const nominalSchema = new mongoose.Schema({
  uuid: uuidField,
  ...nominal.fields,
}, { timestamps: true });

nominal.indexes.forEach(idx => nominalSchema.index(idx.fields, idx.options));

export default {
  modelName: 'nominal',
  schema: nominalSchema
};