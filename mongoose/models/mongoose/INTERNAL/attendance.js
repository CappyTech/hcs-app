const mongoose = require('mongoose');
const crypto = require('crypto');

const attendanceSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
    date: { type: Date, required: true },
    type: {
        type: String,
        enum: ['off', 'holiday', 'sick', 'work', 'training', 'leave'],
        default: 'work'
    },

    // ── Status / approval ───────────────────────────────────────────────
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },

    // ── References ──────────────────────────────────────────────────────
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'location' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },
    contractAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'assignment' },

    // ── Hours & pay ─────────────────────────────────────────────────────
    hoursWorked: { type: mongoose.Decimal128, min: 0 },
    breakMinutes: { type: Number, min: 0, default: 0 },
    overtimeHours: { type: mongoose.Decimal128, min: 0 },
    overtimeRate: { type: mongoose.Decimal128, min: 0 },
    payRate: { type: mongoose.Decimal128, min: 0 },
    dayRate: { type: mongoose.Decimal128, min: 0 },

    // ── Notes ────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 2000 }
}, {
    timestamps: true
});

// ── Indexes ──────────────────────────────────────────────────────────────
attendanceSchema.index({ date: 1 });
attendanceSchema.index({ employeeId: 1, date: 1 });
attendanceSchema.index({ subcontractorId: 1, date: 1 });
attendanceSchema.index({ status: 1 });
// Duplicate-prevention: one attendance per person per date per location/project
attendanceSchema.index(
    { employeeId: 1, date: 1, locationId: 1, projectId: 1 },
    { unique: true, sparse: true, name: 'unique_employee_day_location_project' }
);
attendanceSchema.index(
    { subcontractorId: 1, date: 1, locationId: 1, projectId: 1 },
    { unique: true, sparse: true, name: 'unique_subcontractor_day_location_project' }
);

// ── Pre-validate ─────────────────────────────────────────────────────────
attendanceSchema.pre('validate', function (next) {
    // XOR: must be employee or subcontractor, not both or neither
    if ((this.employeeId && this.subcontractorId) || (!this.employeeId && !this.subcontractorId)) {
        return next(new Error('Attendance must reference either employee or subcontractor, not both or neither.'));
    }

    // hoursWorked and dayRate are mutually exclusive
    if (this.hoursWorked && this.dayRate) {
        return next(new Error('Attendance should have hoursWorked or dayRate, not both.'));
    }

    // For work/training types, require at least a location or project
    const workTypes = ['work', 'training'];
    if (workTypes.includes(this.type) && !this.locationId && !this.projectId) {
        return next(new Error('Work or training attendance must have at least a location or project.'));
    }

    // overtimeHours requires overtimeRate and vice versa
    const hasOT = this.overtimeHours != null && Number(this.overtimeHours.toString ? this.overtimeHours.toString() : this.overtimeHours) > 0;
    const hasOTRate = this.overtimeRate != null && Number(this.overtimeRate.toString ? this.overtimeRate.toString() : this.overtimeRate) > 0;
    if (hasOT && !hasOTRate) {
        return next(new Error('Overtime hours require an overtime rate.'));
    }

    next();
});

module.exports = {
    modelName: 'attendance',
    schema: attendanceSchema
};