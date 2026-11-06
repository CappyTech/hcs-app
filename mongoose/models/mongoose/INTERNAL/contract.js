import mongoose from 'mongoose';
import crypto from 'crypto';

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

  // The Site Managers and Supervisors who run this contract. A project-scoped
  // job role sees a contract's records only while it names them here and
  // isn't Completed (projectScopeService).
  siteManagers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user'
  }],

}, {
  timestamps: true
});

export default {
  modelName: 'contract',
  schema: contractSchema
};
