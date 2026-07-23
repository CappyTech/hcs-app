import mongoose from 'mongoose';
import { vatReturn, uuidField } from '@cappytech/hcs-schemas';

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const vatReturnSchema = new mongoose.Schema({
  uuid: uuidField,
  ...vatReturn.fields,
}, { timestamps: true, strict: false });

vatReturn.indexes.forEach(idx => vatReturnSchema.index(idx.fields, idx.options));

export default {
  modelName: 'vatReturn',
  schema: vatReturnSchema
};
