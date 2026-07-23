import mongoose from 'mongoose';
import { bankTransaction, uuidField } from '@cappytech/hcs-schemas';

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const bankTransactionSchema = new mongoose.Schema({
  uuid: uuidField,
  ...bankTransaction.fields,
}, { timestamps: true, strict: false });

bankTransaction.indexes.forEach(idx => bankTransactionSchema.index(idx.fields, idx.options));

export default {
  modelName: 'bankTransaction',
  schema: bankTransactionSchema
};
