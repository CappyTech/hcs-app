const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const purchaseSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  Id: Number,
  Number: { type: Number, unique: true, required: true },
  SupplierId: Number,
  SupplierCode: String,
  SupplierName: String,
  SupplierReference: String,
  Currency: mongoose.Schema.Types.Mixed,
  DueDate: Date,
  GrossAmount: Number,
  HomeCurrencyGrossAmount: Number,
  IssuedDate: Date,
  FileCount: Number,
  LineItems: [mongoose.Schema.Types.Mixed],
  NetAmount: Number,
  NextNumber: Number,
  OverdueDays: Number,
  PaidDate: Date,
  PaymentLines: [mongoose.Schema.Types.Mixed],
  Permalink: String,
  PreviousNumber: Number,
  PurchaseInECMemberState: Boolean,
  Status: String,
  StockManagementApplicable: Boolean,
  TotalPaidAmount: Number,
  VATAmount: Number,
  AdditionalFieldValue: String,
  IsWhtDeductionToBeApplied: Boolean,
  ReadableString: String,
  SubmissionDate: Date,
  TaxMonth: Number,
  TaxYear: Number
}, { timestamps: true });

module.exports = {
  modelName: 'purchase',
  schema: purchaseSchema
};