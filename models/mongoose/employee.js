const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const employeeSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  name: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  phoneNumber: { type: String },
  contactName: { type: String },
  contactNumber: { type: String },
  position: { type: String },
  type: { type: String, required: true },
  status: { type: String, required: true },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
  hireDate: { type: Date, default: Date.now },
  hourlyRate: { type: mongoose.Decimal128 },
  dailyRate: { type: mongoose.Decimal128 }
}, {
  timestamps: true
});

employeeSchema.pre('validate', function (next) {
  if (this.hourlyRate && this.dailyRate) {
    return next(new Error('Employee should have either hourlyRate or dailyRate, not both.'));
  }
  next();
});

module.exports = mongoose.model('employee', employeeSchema);
