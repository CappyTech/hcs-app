const mongoose = require('mongoose');
const { project, uuidField } = require('@cappytech/hcs-schemas');

const projectSchema = new mongoose.Schema({
  uuid: uuidField,
  ...project.fields,
  // App-managed lifecycle fields (not from KashFlow API)
  deletedAt: { type: Date, default: null },
  lastSeenRun: Date,
}, { timestamps: true });

project.indexes.forEach(idx => projectSchema.index(idx.fields, idx.options));

module.exports = {
  modelName: 'project',
  schema: projectSchema
};