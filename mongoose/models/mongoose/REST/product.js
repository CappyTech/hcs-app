import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { product, uuidField } = schemas;

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const productSchema = new mongoose.Schema({
  uuid: uuidField,
  ...product.fields,
}, { timestamps: true, strict: false });

product.indexes.forEach(idx => productSchema.index(idx.fields, idx.options));

export default {
  modelName: 'product',
  schema: productSchema
};
