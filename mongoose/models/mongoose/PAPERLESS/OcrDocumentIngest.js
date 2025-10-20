// mongoose/models/mongoose/PAPERLESS/OcrDocumentIngest.js
const mongoose = require('mongoose');

const OcrDocumentIngestSchema = new mongoose.Schema({
  paperlessId: { type: Number, index: true, unique: true, required: true },

  // For fast skip checks
  lastModified: { type: Date, index: true },     // Paperless document.modified
  lastContentHash: { type: String, index: true },// SHA-256 of OCR text
  lastFetchedAt: { type: Date },                 // when we last pulled it

  // Optional bookkeeping for downstream usage
  status: { type: String, default: 'fetched', enum: ['fetched', 'skipped', 'error'] },
  error: { type: String, default: null },
}, { timestamps: true });

module.exports = {
  modelName: 'OcrDocumentIngest',
  schema: OcrDocumentIngestSchema,
};
