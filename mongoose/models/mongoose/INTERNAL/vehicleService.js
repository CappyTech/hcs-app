import mongoose from 'mongoose';
import crypto from 'crypto';

const vehicleServiceSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    // ── References ──────────────────────────────────────────────────────
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'vehicle', required: true },

    // ── Service details ─────────────────────────────────────────────────
    date: { type: Date, required: true },
    serviceType: {
        type: String,
        enum: [
            'Full Service', 'Interim Service', 'Major Service',
            'MOT', 'Tyre Replacement', 'Brake Service',
            'Oil Change', 'Battery Replacement',
            'Bodywork Repair', 'Windscreen Repair',
            'Electrical Repair', 'Diagnostic Check',
            'Warranty Repair', 'Recall',
            'Other'
        ],
        required: true
    },
    description: { type: String, trim: true, maxlength: 2000 },

    // ── Provider ────────────────────────────────────────────────────────
    provider: { type: String, trim: true },
    providerContact: { type: String, trim: true },
    providerReference: { type: String, trim: true },

    // ── Costs ───────────────────────────────────────────────────────────
    labourCost: { type: mongoose.Decimal128, default: 0.0 },
    partsCost: { type: mongoose.Decimal128, default: 0.0 },
    vatAmount: { type: mongoose.Decimal128, default: 0.0 },
    totalCost: { type: mongoose.Decimal128, default: 0.0 },

    // ── Mileage at service ──────────────────────────────────────────────
    mileageAtService: { type: Number, min: 0 },

    // ── Outcome ─────────────────────────────────────────────────────────
    status: {
        type: String,
        enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'],
        default: 'Completed'
    },
    nextServiceDueDate: { type: Date },
    nextServiceDueMileage: { type: Number, min: 0 },
    passed: { type: Boolean },                        // for MOT: pass/fail

    // ── Parts replaced ──────────────────────────────────────────────────
    partsReplaced: [{
        name: { type: String, trim: true },
        partNumber: { type: String, trim: true },
        cost: { type: mongoose.Decimal128 },
        quantity: { type: Number, default: 1, min: 1 }
    }],

    // ── Advisories (for MOTs) ───────────────────────────────────────────
    advisories: [{ type: String, trim: true }],

    // ── Payment ─────────────────────────────────────────────────────────
    invoiceReference: { type: String, trim: true },
    paymentMethod: {
        type: String,
        enum: ['Company Card', 'Bank Transfer', 'Cash', 'Account', 'Other']
    },

    // ── Notes ────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 2000 }
}, {
    timestamps: true
});

// ── Indexes ──────────────────────────────────────────────────────────────
vehicleServiceSchema.index({ vehicleId: 1, date: -1 });
vehicleServiceSchema.index({ serviceType: 1 });
vehicleServiceSchema.index({ status: 1 });
vehicleServiceSchema.index({ date: -1 });

export default {
    modelName: 'vehicleService',
    schema: vehicleServiceSchema
};
