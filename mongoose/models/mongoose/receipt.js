const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const ReceiptSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  InvoiceDBID: { type: Number, unique: true, required: true },
  InvoiceNumber: Number,
  InvoiceDate: Date,
  DueDate: Date,
  Customer: String,
  CustomerID: { type: Number, unique: true, required: true },
  Paid: Number,
  CustomerReference: String,
  EstimateCategory: String,
  ProjectID: Number,
  CurrencyCode: String,
  ExchangeRate: Number,
  NetAmount: Number,
  VATAmount: Number,
  AmountPaid: Number,
  CustomerName: String,
  PermaLink: String,
  DeliveryAddress: mongoose.Schema.Types.Mixed,
  UseCustomDeliveryAddress: Boolean,
  CISRCNetAmount: Number,
  CISRCVatAmount: Number,
  IsCISReverseCharge: Boolean,
  ReadableString: String,
  SubmissionDate: Date,
  TaxMonth: Number,
  TaxYear: Number,

  Payments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  Lines: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('receipt', ReceiptSchema);