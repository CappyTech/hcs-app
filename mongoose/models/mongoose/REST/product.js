const mongoose = require('mongoose');
const { product, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const productSchema = new mongoose.Schema({
  uuid: uuidField,
  ...product.fields,
}, { timestamps: true, strict: false });

product.indexes.forEach(idx => productSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'product',
  schema: productSchema
};
