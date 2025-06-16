const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const projectSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  ID: Number,
  Number: Number,
  Name: String,
  Reference: String,
  Description: String,
  Date1: Date,
  Date2: Date,
  CustomerID: Number,
  Status: Number,
});

module.exports = mongoose.model('project', projectSchema);
