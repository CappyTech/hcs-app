const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const projectSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  Id: Number,
  Number: Number,
  Name: String,
  Description: String,
  Reference: String,
  CustomerCode: String,
  CustomerName: String,
  StartDate: Date,
  EndDate: Date,
  Status: Number,
  StatusName: String,
  Note: String,
  ActualJournalsAmount: Number,
  ActualPurchasesAmount: Number,
  ActualSalesAmount: Number,
  TargetPurchasesAmount: Number,
  TargetSalesAmount: Number,
  ActualPurchasesVATAmount: Number,
  ActualSalesVATAmount: Number,
  WorkInProgressAmount: Number,
  ExcludeVAT: Number,
  AssociatedQuotesCount: Number
}, { timestamps: true });

module.exports = {
  modelName: 'project',
  schema: projectSchema
};