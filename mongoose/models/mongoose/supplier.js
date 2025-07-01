const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const supplierSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  SupplierID: Number,
  Code: String,
  Name: String,
  Contact: String,
  Mobile: String,
  Fax: String,
  Address1: String,
  Address2: String,
  Address3: String,
  Address4: String,
  PostCode: String,
  Telephone: String,
  Website: String,
  Email: String,
  Created: Date,
  Updated: Date,
  EC: Number,
  VATNumber: String,
  Notes: String,
  CurrencyID: Number,
  PaymentTerms: Number,
  ContactTitle: String,
  ContactFirstName: String,
  ContactLastName: String,
  TradeBorderType: Number,
  IsSubcontractor: Boolean,
  CISRate: {
    type: String,
    enum: ['0.3', '0.2', '0'],
    default: '0.3'
  },
  CISNumber: {
    type: String,
    default: null
  }
});

module.exports = mongoose.model('supplier', supplierSchema);
