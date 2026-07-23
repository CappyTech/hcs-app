import mongoose from 'mongoose';
import { purchase, uuidField } from '@cappytech/hcs-schemas';

const PaymentLineSchema = new mongoose.Schema(purchase.paymentLineFields, { _id: false });

const purchaseSchema = new mongoose.Schema({
  uuid: uuidField,
  ...purchase.fields,
  PaymentLines: [PaymentLineSchema],
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

purchase.indexes.forEach(idx => purchaseSchema.index(idx.fields, idx.options));

export default {
  modelName: 'purchase',
  schema: purchaseSchema
};