import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { project, uuidField } = schemas;

const projectSchema = new mongoose.Schema({
  uuid: uuidField,
  ...project.fields,
}, { timestamps: true });

project.indexes.forEach(idx => projectSchema.index(idx.fields, idx.options));

export default {
  modelName: 'project',
  schema: projectSchema
};