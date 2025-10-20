// mongoose/models/mongoose/PAPERLESS/OcrDocument.js
const mongoose = require('mongoose');

const CustomFieldSchema = new mongoose.Schema({
  fieldId: Number,
  fieldName: String,
  value: mongoose.Schema.Types.Mixed,
}, { _id: false });

const TagSchema = new mongoose.Schema({
  id: Number,
  name: String,
  slug: String,
}, { _id: false });

const OcrDocumentSchema = new mongoose.Schema({
  paperlessId: { type: Number, index: true, unique: true },
  title: String,
  ocrText: { type: String, default: '' },
  correspondent: { id: Number, name: String },
  documentType: { id: Number, name: String },
  tags: [TagSchema],
  created: Date,
  added: Date,
  modified: Date,
  archiveSerialNumber: String,
  originalFileName: String,
  archivedFileName: String,
  customFields: [CustomFieldSchema],
  fetchedAt: { type: Date, default: () => new Date() },
  error: { type: String, default: null },
}, { timestamps: true });

module.exports = {
  modelName: 'OcrDocument',
  schema: OcrDocumentSchema,
};
