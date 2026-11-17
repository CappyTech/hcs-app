import mongoose from 'mongoose';
import crypto from 'crypto';

const attendanceSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
    date: { type: Date, required: true },
    type: {
        type: String,
        enum: ['off', 'holiday', 'sick', 'work', 'training', 'leave'],
        default: 'work'
    },

    // ── Status / approval ───────────────────────────────────────────────
    // planned (the weekly sheet's plan) → pending (the person confirmed it)
    // → site-approved (Site Manager, where the site names one) → approved
    // (Contracts Manager). A Site Manager marking a planned day attended
    // takes it straight to their step. Payroll reads only `approved`.
    status: {
        type: String,
        enum: ['planned', 'pending', 'site-approved', 'approved', 'rejected'],
        default: 'pending'
    },
    siteApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    siteApprovedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    approvedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 500 },

    // ── References ──────────────────────────────────────────────────────
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'location' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },
    contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },
    contractAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'assignment' },

    // ── Hours & pay (employees only) ────────────────────────────────────
    // Payroll pays hoursWorked × the employee's hourlyRate, or dayRate when
    // set. Subcontractors are paid on their CIS invoices, so their records
    // hold only where and when: see SUBCONTRACTOR_PAY_FIELDS below.
    hoursWorked: { type: mongoose.Decimal128, min: 0 },
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
// Duplicate-prevention: one attendance per person per date per location and
// project, and per location and contract. Each index covers only its own kind
// of record (partialFilterExpression): with `sparse` on a compound index, an
// employee's record was indexed with subcontractorId null, so two employees
// at one location on one day collided on the subcontractor index (and two
// subcontractors on the employee one). See UNIQUE_INDEXES in
// attendanceIndexMigration.js, which replaces the old sparse ones.
export const UNIQUE_INDEXES = [
    { name: 'unique_employee_day_location_project', person: 'employeeId', keys: { employeeId: 1, date: 1, locationId: 1, projectId: 1 } },
    { name: 'unique_subcontractor_day_location_project', person: 'subcontractorId', keys: { subcontractorId: 1, date: 1, locationId: 1, projectId: 1 } },
    { name: 'unique_employee_day_location_contract', person: 'employeeId', keys: { employeeId: 1, date: 1, locationId: 1, contractId: 1 } },
    { name: 'unique_subcontractor_day_location_contract', person: 'subcontractorId', keys: { subcontractorId: 1, date: 1, locationId: 1, contractId: 1 } },
];
for (const ix of UNIQUE_INDEXES) {
    attendanceSchema.index(ix.keys, { unique: true, name: ix.name, partialFilterExpression: { [ix.person]: { $type: 'objectId' } } });
}

// Fields a subcontractor's record never holds (they're paid via CIS
// invoices, not payroll). The pre-validate hook below drops them.
export const SUBCONTRACTOR_PAY_FIELDS = ['hoursWorked', 'dayRate'];

// Fields removed from attendance altogether. Old documents may still carry
// them until attendanceCleanupService clears them at start-up.
export const REMOVED_FIELDS = ['breakMinutes', 'overtimeHours', 'overtimeRate', 'payRate'];

/**
 * Drop hoursWorked/dayRate from plain attendance data for a subcontractor.
 * Mutates and returns `data`. For writers that skip document validation
 * (insertMany of plain objects is validated, findOneAndUpdate isn't).
 */
export function stripSubcontractorPay(data) {
    if (data && data.subcontractorId) {
        for (const f of SUBCONTRACTOR_PAY_FIELDS) delete data[f];
    }
    return data;
}

// ── Pre-validate ─────────────────────────────────────────────────────────
attendanceSchema.pre('validate', function (next) {
    // XOR: must be employee or subcontractor, not both or neither
    if ((this.employeeId && this.subcontractorId) || (!this.employeeId && !this.subcontractorId)) {
        return next(new Error('Attendance must reference either employee or subcontractor, not both or neither.'));
    }

    // A subcontractor's record holds where and when only, never hours or pay
    if (this.subcontractorId) {
        for (const f of SUBCONTRACTOR_PAY_FIELDS) {
            if (this.get(f) != null) this.set(f, undefined);
        }
    }

    // hoursWorked and dayRate are mutually exclusive
    if (this.hoursWorked && this.dayRate) {
        return next(new Error('Attendance should have hoursWorked or dayRate, not both.'));
    }

    // For work/training types, require at least a location, project, or contract
    const workTypes = ['work', 'training'];
    if (workTypes.includes(this.type) && !this.locationId && !this.projectId && !this.contractId) {
        return next(new Error('Work or training attendance must have at least a location, project, or contract.'));
    }

    next();
});

export default {
    modelName: 'attendance',
    schema: attendanceSchema
};