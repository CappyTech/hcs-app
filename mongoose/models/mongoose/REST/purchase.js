import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { purchase, uuidField } = schemas;

const PaymentLineSchema = new mongoose.Schema(purchase.paymentLineFields, { _id: false });

const purchaseSchema = new mongoose.Schema({
  uuid: uuidField,
  ...purchase.fields,
  PaymentLines: [PaymentLineSchema],
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

purchase.indexes.forEach(idx => purchaseSchema.index(idx.fields, idx.options));

// Job costs (jobCostService): purchases are tied to a job per line, with the
// header's ProjectNumber as the fallback, so both are looked up. Built by
// Mongoose's autoIndex like the shared indexes above; a failure is logged by
// Mongoose and never stops start-up.
purchaseSchema.index({ 'LineItems.ProjectNumber': 1 });
purchaseSchema.index({ ProjectNumber: 1 });

export default {
  modelName: 'purchase',
  schema: purchaseSchema
};