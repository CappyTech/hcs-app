import mongoose from 'mongoose';
import { purchaseOrderCategory, uuidField } from '@cappytech/hcs-schemas';

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const purchaseOrderCategorySchema = new mongoose.Schema({
  uuid: uuidField,
  ...purchaseOrderCategory.fields,
}, { timestamps: true, strict: false });

purchaseOrderCategory.indexes.forEach(idx => purchaseOrderCategorySchema.index(idx.fields, idx.options));

export default {
  modelName: 'purchaseOrderCategory',
  schema: purchaseOrderCategorySchema
};
