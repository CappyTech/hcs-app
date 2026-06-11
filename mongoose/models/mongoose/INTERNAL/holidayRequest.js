'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Individual leave bookings (the request → approval workflow).
 * Entitlement/accrual totals live in employeeHoliday; approving a request
 * here increments takenDays on the matching period via holidayRequestService.
 */

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const LEAVE_TYPES = ['annual', 'unpaid', 'other'];

const holidayRequestSchema = new mongoose.Schema(
  {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee', required: true, index: true },

    startDate: { type: Date, required: true },
    endDate:   { type: Date, required: true },

    // Working days requested (half days allowed)
    daysRequested: { type: Number, required: true, min: 0.5 },

    leaveType: { type: String, enum: LEAVE_TYPES, default: 'annual' },
    reason:    { type: String, trim: true, maxlength: 1000, default: '' },

    status: { type: String, enum: STATUSES, default: 'pending', index: true },

    // Review trail
    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedAt:  { type: Date, default: null },
    reviewNotes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true },
);

holidayRequestSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    return next(new Error('End date must be on or after the start date.'));
  }
  next();
});

// Manager dashboard: pending first, newest first
holidayRequestSchema.index({ status: 1, startDate: 1 });

module.exports = { modelName: 'holidayRequest', schema: holidayRequestSchema };
