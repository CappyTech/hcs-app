const mongoose = require('mongoose');
const crypto = require('crypto');

const contractSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  quoteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'quote',
    required: false
  },

  title: {
    type: String,
    required: true
  },

  location: {
    type: String,
    required: true
  },

  startDate: {
    type: Date,
    required: false
  },

  endDate: {
    type: Date,
    required: false
  },

  status: {
    type: String,
    enum: ['Planned', 'In Progress', 'Completed'],
    default: 'Planned'
  },

  notes: {
    type: String
  },

  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'project'
  },
  
  locationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'location'
  },

}, {
  timestamps: true
});

module.exports = {
  modelName: 'contract',
  schema: contractSchema
};
