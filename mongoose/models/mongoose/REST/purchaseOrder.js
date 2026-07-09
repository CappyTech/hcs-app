const mongoose = require('mongoose');
const { purchaseOrder, uuidField } = require('@cappytech/hcs-schemas');

// strict: false — KashFlow's documented shape for this entity is incomplete;
// undeclared fields written by hcs-sync must survive round-trips.
const purchaseOrderSchema = new mongoose.Schema({
  uuid: uuidField,
  ...purchaseOrder.fields,
}, { timestamps: true, strict: false });

purchaseOrder.indexes.forEach(idx => purchaseOrderSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'purchaseOrder',
  schema: purchaseOrderSchema
};
