const mongoose = require('mongoose');
const { purchaseOrderCategory, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const purchaseOrderCategorySchema = new mongoose.Schema({
  uuid: uuidField,
  ...purchaseOrderCategory.fields,
}, { timestamps: true, strict: false });

purchaseOrderCategory.indexes.forEach(idx => purchaseOrderCategorySchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'purchaseOrderCategory',
  schema: purchaseOrderCategorySchema
};
