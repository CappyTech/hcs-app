import mongoose from 'mongoose';
import schemas from '@cappytech/hcs-schemas';
const { invoice, uuidField } = schemas;

// Payment lines were untyped Mixed until hcs-schemas 2.1.0, holding raw
// "YYYY-MM-DD HH:mm:ss" strings that no date query could reach. Wrapping them
// is opt-in: invoice.fields still carries PaymentLines: [{}] so older
// consumers keep working, and setting it after the spread overrides that.
//
// strict:false because KashFlow's documented payment-line shape is incomplete
// (BankReconciliationId, for one, is undocumented but always present) and
// hcs-sync writes through the native driver, so undeclared fields are already
// on disk — a strict sub-schema would hide them on read rather than remove them.
//
// Guarded so this still loads against hcs-schemas < 2.1.0.
const PaymentLineSchema = invoice.paymentLineFields
  ? new mongoose.Schema(invoice.paymentLineFields, { _id: false, strict: false })
  : null;

const invoiceSchema = new mongoose.Schema({
  uuid: uuidField,
  ...invoice.fields,
  ...(PaymentLineSchema ? { PaymentLines: [PaymentLineSchema] } : {}),
  syncedAt: { type: Date, default: null },
  detailSyncedAt: { type: Date, default: null },
}, { timestamps: true });

invoice.indexes.forEach(idx => invoiceSchema.index(idx.fields, idx.options));

export default {
  modelName: 'invoice',
  schema: invoiceSchema
};