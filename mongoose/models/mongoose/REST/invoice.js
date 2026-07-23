import mongoose from 'mongoose';
import { invoice, uuidField } from '@cappytech/hcs-schemas';

const invoiceSchema = new mongoose.Schema({
  uuid: uuidField,
  ...invoice.fields,
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

invoice.indexes.forEach(idx => invoiceSchema.index(idx.fields, idx.options));

export default {
  modelName: 'invoice',
  schema: invoiceSchema
};