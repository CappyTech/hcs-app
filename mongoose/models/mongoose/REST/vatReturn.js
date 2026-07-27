import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { vatReturn, uuidField } = schemas;

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
