const mongoose = require('mongoose');
const crypto = require('crypto');

const USAGE_TYPES = ['site', 'delivery', 'maintenance', 'office', 'other'];

const vehicleDeploymentSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'vehicle',
    required: true
  },

  date: {
    type: Date,
    required: true
  },

  // ── Driver (either employee OR subcontractor, or neither for unassigned) ─
  driverEmployeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'employee'
  },
  driverSubcontractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'supplier'
  },

  // ── Deployment details ──────────────────────────────────────────────
  locationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'location'
  },
  contractId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'contract'
  },

  startMileage: {
    type: Number,
    min: 0
  },
  endMileage: {
    type: Number,
    min: 0
  },

  usageType: {
    type: String,
    enum: USAGE_TYPES,
    default: 'site'
  },

  notes: {
    type: String,
    trim: true,
    maxlength: 500
  }

}, {
  timestamps: true
});

// ── Index for efficient weekly lookups ──────────────────────────────
vehicleDeploymentSchema.index({ date: 1 });
vehicleDeploymentSchema.index({ vehicleId: 1, date: 1 });

// ── XOR: driverEmployeeId and driverSubcontractorId are mutually exclusive ─
vehicleDeploymentSchema.pre('validate', function (next) {
  if (this.driverEmployeeId && this.driverSubcontractorId) {
    return next(new Error('A vehicle deployment cannot have both a driver employee and a driver subcontractor.'));
  }
  next();
});

// ── endMileage must be >= startMileage if both provided ─────────────
vehicleDeploymentSchema.pre('validate', function (next) {
  if (this.startMileage != null && this.endMileage != null && this.endMileage < this.startMileage) {
    return next(new Error('End mileage cannot be less than start mileage.'));
  }
  next();
});

module.exports = {
  modelName: 'vehicleDeployment',
  schema: vehicleDeploymentSchema
};
