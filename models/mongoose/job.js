const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const jobSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  jobRef: { type: String, required: true },
  quoteRef: { type: String },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'location' },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier', default: null },
  description: String,
  startDate: Date,
  endDate: Date,
  status: { type: String, enum: ['scheduled','active','completed','archived'], default: 'scheduled' }
}, {
  timestamps: true
});

jobSchema.pre('validate', function (next) {
  if (this.employeeId && this.supplierId) {
    return next(new Error('Job cannot reference both employee and supplier.'));
  }
  next();
});

module.exports = mongoose.model('job', jobSchema);
