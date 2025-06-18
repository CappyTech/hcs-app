const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const jobSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  jobRef: { type: String, required: true },
  quoteRef: { type: String },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'location' },
  description: String,
  startDate: Date,
  endDate: Date,
  status: { type: String, enum: ['scheduled','active','completed','archived'], default: 'scheduled' }
}, {
  timestamps: true
});

module.exports = mongoose.model('job', jobSchema);
