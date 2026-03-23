const mongoose = require('mongoose');
const crypto = require('crypto');

const vehicleFuelLogSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    // ── References ──────────────────────────────────────────────────────
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'vehicle', required: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },

    // ── Fill-up details ─────────────────────────────────────────────────
    date: { type: Date, required: true },
    fuelType: {
        type: String,
        enum: ['Petrol', 'Diesel', 'Electric', 'Hybrid', 'LPG', 'Hydrogen', 'AdBlue'],
        required: true
    },
    litres: { type: mongoose.Decimal128, required: true, min: 0 },
    costPerLitre: { type: mongoose.Decimal128, min: 0 },
    totalCost: { type: mongoose.Decimal128, required: true, min: 0 },
    fullTank: { type: Boolean, default: true },

    // ── Odometer ────────────────────────────────────────────────────────
    mileageAtFillUp: { type: Number, min: 0 },

    // ── Location ────────────────────────────────────────────────────────
    station: { type: String, trim: true },
    location: { type: String, trim: true },

    // ── Payment ─────────────────────────────────────────────────────────
    paymentMethod: {
        type: String,
        enum: ['Fuel Card', 'Company Card', 'Cash', 'Personal (Expense)', 'Other']
    },
    receiptReference: { type: String, trim: true },

    // ── Notes ────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 1000 }
}, {
    timestamps: true
});

// ── Indexes ──────────────────────────────────────────────────────────────
vehicleFuelLogSchema.index({ vehicleId: 1, date: -1 });
vehicleFuelLogSchema.index({ employeeId: 1 });
vehicleFuelLogSchema.index({ date: -1 });

// ── Pre-validate: XOR guard for driver ───────────────────────────────────
vehicleFuelLogSchema.pre('validate', function (next) {
    if (this.employeeId && this.subcontractorId) {
        return next(new Error('Fuel log driver must be either an employee or a subcontractor, not both.'));
    }
    next();
});

module.exports = {
    modelName: 'vehicleFuelLog',
    schema: vehicleFuelLogSchema
};
