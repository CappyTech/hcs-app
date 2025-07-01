const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const assignmentSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  contractId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'contract',
    required: true
  },

  title: {
    type: String,
    required: true
  },

  description: {
    type: String
  },

  weekStart: {
    type: Date,
    required: true // this should always be a Monday
  },

  assignedEmployees: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'employee'
  }],

  assignedSubcontractors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'supplier'
  }],

  estimatedHours: {
    type: Number,
    min: 0
  },

  status: {
    type: String,
    enum: ['Planned', 'In Progress', 'Done'],
    default: 'Planned'
  }

}, {
  timestamps: true
});

module.exports = mongoose.model('assignment', assignmentSchema);
