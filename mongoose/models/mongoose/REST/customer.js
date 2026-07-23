import mongoose from 'mongoose';
import { customer, uuidField } from '@cappytech/hcs-schemas';

const customerSchema = new mongoose.Schema({
  uuid: uuidField,
  ...customer.fields,
}, { timestamps: true });

customer.indexes.forEach(idx => customerSchema.index(idx.fields, idx.options));

export default {
  modelName: 'customer',
  schema: customerSchema
};