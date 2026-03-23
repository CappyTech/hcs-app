const mongoose = require('mongoose');
const { purchase, uuidField } = require('@cappytech/hcs-schemas');

const PaymentLineSchema = new mongoose.Schema(purchase.paymentLineFields, { _id: false });

const purchaseSchema = new mongoose.Schema({
  uuid: uuidField,
  ...purchase.fields,
  PaymentLines: [PaymentLineSchema],
}, { timestamps: true });

purchase.indexes.forEach(idx => purchaseSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'purchase',
  schema: purchaseSchema
};