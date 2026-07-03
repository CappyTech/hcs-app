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
  // Optional linkage to a created KashFlow Purchase (post-send enrichment)
  kashflowPurchaseId:     { type: Number, default: null, index: true },
  kashflowPurchaseNumber: { type: Number, default: null },
  kashflowPermalink:      { type: String, default: null },
  lastSentAt:             { type: Date,   default: null, index: true },
  lastSendMode:           { type: String, enum: ['direct', 'webhook', null], default: null, index: true },
  lastSendStatus:         { type: Number, default: null },
  modifiedAtLastSend:     { type: Date,   default: null },
  kfSendLockedAt:         { type: Date,   default: null }, // in-flight send claim — blocks concurrent sends (stale after 5 min)
  sendCount:              { type: Number },
  fetchedAt:              { type: Date, default: () => new Date() },
  // Set by the grab's reconciliation pass when a full unfiltered sweep no longer sees
  // this document in Paperless (deleted there). Cleared automatically if it reappears.
  deletedInPaperlessAt:   { type: Date, default: null, index: true },
  error: { type: String, default: null },
}, { timestamps: true });

module.exports = {
  modelName: 'OcrDocument',
  schema: OcrDocumentSchema,
};
