const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const customerSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  CustomerID: Number,
  Code: String,
  Name: String,
  Contact: String,
  Telephone: String,
  Mobile: String,
  Email: String,
  Address1: String,
  Address2: String,
  Address3: String,
  Postcode: String,
  CountryName: String,
  Website: String,
  Notes: String,
  Discount: Number,
  Created: Date,
  Updated: Date,
});

module.exports = mongoose.model('customer', customerSchema);
