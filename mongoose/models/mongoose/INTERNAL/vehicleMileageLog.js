import mongoose from 'mongoose';
import crypto from 'crypto';

const vehicleMileageLogSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    // ── References ──────────────────────────────────────────────────────
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'vehicle', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },

    // ── Trip details ────────────────────────────────────────────────────
    date: { type: Date, required: true },
    startMileage: { type: Number, required: true, min: 0 },
    endMileage: { type: Number, required: true, min: 0 },
    distance: { type: Number, min: 0 },              // computed or manual
    startLocation: { type: String, trim: true },
    endLocation: { type: String, trim: true },

    // ── Purpose ─────────────────────────────────────────────────────────
    tripPurpose: {
        type: String,
        enum: ['Business', 'Commute', 'Personal', 'Site Visit', 'Delivery', 'Client Meeting', 'Training', 'Other'],
        default: 'Business'
    },
    description: { type: String, trim: true, maxlength: 500 },

    // ── HMRC mileage claim ──────────────────────────────────────────────
    claimable: { type: Boolean, default: true },
    hmrcRate: { type: mongoose.Decimal128 },          // pence per mile at time of trip
    claimAmount: { type: mongoose.Decimal128 },       // distance × rate

    // ── Notes ────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 1000 }
}, {
    timestamps: true
});

// ── Indexes ──────────────────────────────────────────────────────────────
vehicleMileageLogSchema.index({ vehicleId: 1, date: -1 });
vehicleMileageLogSchema.index({ employeeId: 1, date: -1 });
vehicleMileageLogSchema.index({ date: -1 });
vehicleMileageLogSchema.index({ tripPurpose: 1 });

// ── Pre-validate ─────────────────────────────────────────────────────────
vehicleMileageLogSchema.pre('validate', function (next) {
    // XOR: driver is employee or subcontractor, not both
    if (this.employeeId && this.subcontractorId) {
        return next(new Error('Mileage log must reference either an employee or a subcontractor, not both.'));
    }

    // endMileage must be >= startMileage
    if (this.endMileage != null && this.startMileage != null && this.endMileage < this.startMileage) {
        return next(new Error('End mileage must be greater than or equal to start mileage.'));
    }

    // Auto-compute distance if not supplied
    if (this.startMileage != null && this.endMileage != null) {
        this.distance = this.endMileage - this.startMileage;
    }

    // Auto-compute HMRC claim amount if rate and distance available
    if (this.claimable && this.distance != null && this.hmrcRate != null) {
        const rate = typeof this.hmrcRate === 'object' && this.hmrcRate.toString
            ? Number(this.hmrcRate.toString())
            : Number(this.hmrcRate);
        if (!isNaN(rate) && rate > 0) {
            const amount = (this.distance * rate / 100).toFixed(2); // rate is pence, convert to £
            this.claimAmount = mongoose.Types.Decimal128.fromString(amount);
        }
    }

    next();
});

export default {
    modelName: 'vehicleMileageLog',
    schema: vehicleMileageLogSchema
};
