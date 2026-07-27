import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { bankAccount, uuidField } = schemas;

const bankAccountSchema = new mongoose.Schema({
  uuid: uuidField,
  ...bankAccount.fields,
}, { timestamps: true });

bankAccount.indexes.forEach(idx => bankAccountSchema.index(idx.fields, idx.options));

export default {
  modelName: 'bankAccount',
  schema: bankAccountSchema
};
