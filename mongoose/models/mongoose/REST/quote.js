import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { quote, uuidField } = schemas;

const quoteSchema = new mongoose.Schema({
  uuid: uuidField,
  ...quote.fields,
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

quote.indexes.forEach(idx => quoteSchema.index(idx.fields, idx.options));

export default {
  modelName: 'quote',
  schema: quoteSchema
};