// mongoose/models/mongoose/PAPERLESS/DocumentText.js
import mongoose from 'mongoose';

// The positioned text PDF.js reads off a document's archive PDF, kept so the
// invoice reader can run again (new reader version, a supplier's learned
// layout, a test fixture) without fetching the PDF from Paperless each time.
// Each item is [text, x, y, width, height, page] in PDF units, origin bottom-left.
const DocumentTextSchema = new mongoose.Schema({
  paperlessId:   { type: Number, required: true, unique: true, index: true },
  pages:         { type: Number, default: 0 },
  items:         { type: [mongoose.Schema.Types.Mixed], default: [] },
  pageWidth:     { type: Number, default: 595 },
  readAt:        { type: Date, default: null },
  readerVersion: { type: Number, default: null },
}, { timestamps: true });

export default {
  modelName: 'DocumentText',
  schema: DocumentTextSchema,
};
