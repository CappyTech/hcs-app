import mongoose from 'mongoose';
import { quoteCategory, uuidField } from '@cappytech/hcs-schemas';

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const quoteCategorySchema = new mongoose.Schema({
  uuid: uuidField,
  ...quoteCategory.fields,
}, { timestamps: true, strict: false });

quoteCategory.indexes.forEach(idx => quoteCategorySchema.index(idx.fields, idx.options));

export default {
  modelName: 'quoteCategory',
  schema: quoteCategorySchema
};
