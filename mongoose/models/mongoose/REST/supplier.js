import mongoose from 'mongoose';
import { supplier, uuidField } from '@cappytech/hcs-schemas';

const supplierSchema = new mongoose.Schema({
  uuid: uuidField,
  ...supplier.fields,
}, { timestamps: true });

supplier.indexes.forEach(idx => supplierSchema.index(idx.fields, idx.options));

export default {
  modelName: 'supplier',
  schema: supplierSchema
};