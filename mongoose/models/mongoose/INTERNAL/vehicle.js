import mongoose from 'mongoose';
import crypto from 'crypto';
import logger from '../../../../services/loggerService.js';

const vehicleSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

    // ── Ownership / assignment ──────────────────────────────────────────
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },

    // ── Identity ────────────────────────────────────────────────────────
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    registrationNumber: {
        type: String, required: true, unique: true, trim: true,
        uppercase: true
    },
    color: { type: String, trim: true },
    year: {
        type: Number,
        min: [1900, 'Year must be 1900 or later'],
        max: [new Date().getFullYear() + 1, 'Year cannot be in the future']
    },
    vin: {
        type: String, unique: true, sparse: true, trim: true, uppercase: true,
        minlength: [17, 'VIN must be 17 characters'],
        maxlength: [17, 'VIN must be 17 characters']
    },
    engineNumber: { type: String, unique: true, sparse: true, trim: true },

    // ── Specification ───────────────────────────────────────────────────
    fuelType: {
        type: String,
        enum: ['Petrol', 'Diesel', 'Electric', 'Hybrid', 'Plug-in Hybrid', 'LPG', 'Hydrogen']
    },
    engineSize: { type: Number, min: 0 },            // cc
    transmission: {
        type: String,
        enum: ['Manual', 'Automatic', 'Semi-Automatic']
    },
    bodyType: {
        type: String,
        enum: ['Car', 'Van', 'Pickup', 'Tipper', 'Flatbed', 'Minibus', 'HGV', 'Welfare Unit', 'Other']
    },
    grossWeight: { type: Number, min: 0 },            // kg
    payload: { type: Number, min: 0 },                 // kg

    // ── Mileage ─────────────────────────────────────────────────────────
    currentMileage: { type: Number, min: 0, default: 0 },
    lastMileageUpdate: { type: Date },

    // ── Insurance ───────────────────────────────────────────────────────
    insuranceProvider: { type: String, trim: true },
    insurancePolicyNumber: { type: String, unique: true, sparse: true, trim: true },
    insuranceExpiryDate: { type: Date },
    insuranceCost: { type: mongoose.Decimal128, default: 0.0 },

    // ── MOT & road tax ──────────────────────────────────────────────────
    motExpiryDate: { type: Date },
    motCertificateNumber: { type: String, trim: true },
    roadTaxExpiryDate: { type: Date },
    roadTaxAmount: { type: mongoose.Decimal128, default: 0.0 },

    // ── Breakdown cover ─────────────────────────────────────────────────
    breakdownProvider: { type: String, trim: true },
    breakdownExpiryDate: { type: Date },

    // ── Ownership / lease ───────────────────────────────────────────────
    ownershipStatus: {
        type: String,
        enum: ['Owned', 'Leased', 'Rented', 'Hire Purchase', 'Company Car']
    },
    purchaseDate: { type: Date },
    purchasePrice: { type: mongoose.Decimal128 },
    leaseProvider: { type: String, trim: true },
    leaseExpiryDate: { type: Date },
    leaseMonthlyCost: { type: mongoose.Decimal128 },

    // ── Usage ───────────────────────────────────────────────────────────
    assignedDepartment: { type: String, trim: true },
    vehicleUsage: {
        type: String,
        enum: ['Passenger Transport', 'Delivery', 'Maintenance', 'Administrative', 'Site Vehicle', 'Pool Vehicle', 'Other']
    },
    availabilityStatus: {
        type: String,
        enum: ['Available', 'In Use', 'Under Maintenance', 'Out of Service', 'Disposed'],
        default: 'Available'
    },

    // ── Servicing ───────────────────────────────────────────────────────
    lastServiceDate: { type: Date },
    lastServiceMileage: { type: Number, min: 0 },
    nextServiceDueDate: { type: Date },
    nextServiceDueMileage: { type: Number, min: 0 },

    // ── Notes ────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 2000 }
}, {
    timestamps: true
});

// ── Indexes ──────────────────────────────────────────────────────────────
vehicleSchema.index({ employeeId: 1 });
vehicleSchema.index({ subcontractorId: 1 });
vehicleSchema.index({ projectId: 1 });
vehicleSchema.index({ availabilityStatus: 1 });
vehicleSchema.index({ motExpiryDate: 1 });
vehicleSchema.index({ insuranceExpiryDate: 1 });
vehicleSchema.index({ roadTaxExpiryDate: 1 });

// ── Virtual: display name ────────────────────────────────────────────────
vehicleSchema.virtual('displayName').get(function () {
    return `${this.registrationNumber} – ${this.make} ${this.model}`;
});

// ── Pre-validate: XOR guard for employee / subcontractor ─────────────────
vehicleSchema.pre('validate', function (next) {
    if (this.employeeId && this.subcontractorId) {
        return next(new Error('Vehicle must be assigned to either an employee or a subcontractor, not both.'));
    }

    // Warn when compliance dates are already past
    const now = new Date();
    const warnFields = ['motExpiryDate', 'insuranceExpiryDate', 'roadTaxExpiryDate'];
    for (const field of warnFields) {
        if (this[field] && this[field] < now && this.isModified(field)) {
            logger.warn(`[vehicle] ${this.registrationNumber}: ${field} is set to a past date (${this[field].toISOString()})`);
        }
    }

    next();
});

export default {
    modelName: 'vehicle',
    schema: vehicleSchema
};
