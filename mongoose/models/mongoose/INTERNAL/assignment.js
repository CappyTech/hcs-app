import mongoose from 'mongoose';
import crypto from 'crypto';

const assignmentSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
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
    required: true
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

export default {
  modelName: 'assignment',
  schema: assignmentSchema
};
