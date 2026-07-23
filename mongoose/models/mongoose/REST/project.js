import mongoose from 'mongoose';
import { project, uuidField } from '@cappytech/hcs-schemas';

const projectSchema = new mongoose.Schema({
  uuid: uuidField,
  ...project.fields,
}, { timestamps: true });

project.indexes.forEach(idx => projectSchema.index(idx.fields, idx.options));

export default {
  modelName: 'project',
  schema: projectSchema
};