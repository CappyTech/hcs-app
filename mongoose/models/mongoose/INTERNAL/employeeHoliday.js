const mongoose = require('mongoose');
const crypto = require('crypto');

// UK holiday accrual rules vary. This model captures entitlement and accrual for a given holiday year window per employee.
// It does not record individual leave bookings here (can be a separate model later); it tracks totals for entitlement, accrued and taken.
const employeeHolidaySchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  // Link to employee
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', required: true, index: true },

  // Holiday year window (e.g., 6 Apr 2025 to 5 Apr 2026) or company policy window
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },

  // Entitlement baseline for the period
  entitlementDays: { type: Number, default: null }, // if entitlement is tracked in days
  entitlementHours: { type: Number, default: null }, // if entitlement is tracked in hours
  entitlementType: { type: String, enum: ['days', 'hours'], default: 'days' },

  // Carry over from previous year (approved)
  carryOverDays: { type: Number, default: 0 },
  carryOverHours: { type: Number, default: 0 },
  // Set once by the year-end carry-over job so it never reapplies (null = not yet processed)
  carryOverAppliedAt: { type: Date, default: null },

  // Accrual policy
  accrualMethod: { type: String, enum: ['fixed', 'per-hour', 'per-day'], default: 'fixed' },
  // 12.07% is common in the UK for casual/zero-hours workers
  accrualPercent: { type: Number, default: 12.07 }, // percentage of hours/days worked that accrue as holiday

  // Running totals (can be updated by jobs/services)
  accruedDays: { type: Number, default: 0 },
  accruedHours: { type: Number, default: 0 },
  takenDays: { type: Number, default: 0 },
  takenHours: { type: Number, default: 0 },

  // Policy flags
  bankHolidaysCounted: { type: Boolean, default: true }, // true if bank holidays are part of entitlement

  notes: { type: String, default: '' }
}, { timestamps: true });

// Ensure only one record per employee per period window
employeeHolidaySchema.index({ employeeId: 1, periodStart: 1, periodEnd: 1 }, { unique: true });

module.exports = {
  modelName: 'employeeHoliday',
  schema: employeeHolidaySchema
};
