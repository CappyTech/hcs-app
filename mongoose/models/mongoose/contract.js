const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const contractSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  quoteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'quote', // or 'Quote' depending on your actual model name
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

module.exports = mongoose.model('contract', contractSchema);
