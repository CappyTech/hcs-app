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
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  type: {
    type: String,
    enum: ['full-time', 'part-time'],
    default: 'full-time'
  },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
  hireDate: { type: Date, default: Date.now },
  hourlyRate: { type: mongoose.Decimal128 },
  dailyRate: { type: mongoose.Decimal128 }
}, {
  timestamps: true
});

// Contract terms and holiday policy attachments (extensible without breaking existing docs)
employeeSchema.add({
  // Contract terms
  contract: {
    termsType: { type: String, enum: ['permanent', 'temporary', 'zero-hours', 'fixed-term'], default: 'permanent' },
    hoursPerWeek: { type: Number, default: null },
    workingDaysPerWeek: { type: Number, default: 5 },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    noticePeriodWeeks: { type: Number, default: null }
  },
  // Holiday policy (per employee override)
  holidayPolicy: {
    entitlementType: { type: String, enum: ['days', 'hours'], default: 'days' },
    entitlementValue: { type: Number, default: 28 }, // UK statutory max incl. bank holidays for full-time
    includesBankHolidays: { type: Boolean, default: true },
    accrualMethod: { type: String, enum: ['fixed', 'per-hour', 'per-day'], default: 'fixed' },
    accrualPercent: { type: Number, default: 12.07 },
    carryOverMaxDays: { type: Number, default: 0 },
    carryOverMaxHours: { type: Number, default: 0 }
  }
});

employeeSchema.pre('validate', function (next) {
  if (this.hourlyRate && this.dailyRate) {
    return next(new Error('Employee should have either hourlyRate or dailyRate, not both.'));
  }
  next();
});

module.exports = {
  modelName: 'employee',
  schema: employeeSchema
};
