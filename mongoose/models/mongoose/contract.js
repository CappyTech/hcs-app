const mongoose = require('mongoose');

const contractSchema = new mongoose.Schema({
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
  }

}, {
  timestamps: true
});

module.exports = mongoose.model('contract', contractSchema);
