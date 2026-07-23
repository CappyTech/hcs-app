import mongoose from 'mongoose';
import { vatRate, uuidField } from '@cappytech/hcs-schemas';

const vatRateSchema = new mongoose.Schema({
  uuid: uuidField,
  ...vatRate.fields,
}, {
  collection: vatRate.collection,
  strict: false,
  timestamps: true,
});

vatRate.indexes.forEach(idx => vatRateSchema.index(idx.fields, idx.options));

export default {
  modelName: 'vatrate',
  schema: vatRateSchema,
};
