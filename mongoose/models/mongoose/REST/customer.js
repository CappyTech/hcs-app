import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { customer, uuidField } = schemas;

const customerSchema = new mongoose.Schema({
  uuid: uuidField,
  ...customer.fields,
}, { timestamps: true });

customer.indexes.forEach(idx => customerSchema.index(idx.fields, idx.options));

export default {
  modelName: 'customer',
  schema: customerSchema
};