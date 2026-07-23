import mongoose from 'mongoose';
import { accountingPeriod, uuidField } from '@cappytech/hcs-schemas';

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const accountingPeriodSchema = new mongoose.Schema({
  uuid: uuidField,
  ...accountingPeriod.fields,
}, { timestamps: true, strict: false });

accountingPeriod.indexes.forEach(idx => accountingPeriodSchema.index(idx.fields, idx.options));

export default {
  modelName: 'accountingPeriod',
  schema: accountingPeriodSchema
};
