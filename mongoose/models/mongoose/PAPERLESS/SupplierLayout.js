// mongoose/models/mongoose/PAPERLESS/SupplierLayout.js
import mongoose from 'mongoose';

// Where a supplier's invoices put each field, learned from what people save on
// the entry screen. One document per Paperless correspondent. `spots` keeps a
// few places per field ({page, x, y, w, h, seen, lastAt}, PDF units), most
// seen first; the invoice reader prefers a value found at the top one.
const SupplierLayoutSchema = new mongoose.Schema({
  correspondentId:   { type: Number, required: true, unique: true, index: true },
  correspondentName: { type: String, default: null },
  spots:             { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  invoicesLearned:   { type: Number, default: 0 },
}, { timestamps: true, minimize: false });

export default {
  modelName: 'SupplierLayout',
  schema: SupplierLayoutSchema,
};
