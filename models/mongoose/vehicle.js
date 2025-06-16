const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const vehicleSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'job' },
    make: { type: String, required: true },
    model: { type: String, required: true },
    registrationNumber: { type: String, required: true, unique: true },
    color: String,
    year: Number,
    vin: { type: String, unique: true },
    engineNumber: { type: String, unique: true },
    fuelType: {
        type: String,
        enum: ['Petrol', 'Diesel', 'Electric', 'Hybrid']
    },
    mileage: Number,
    insuranceProvider: String,
    insurancePolicyNumber: { type: String, unique: true },
    insuranceExpiryDate: Date,
    motExpiryDate: Date,
    roadTaxExpiryDate: Date,
    roadTaxAmount: { type: mongoose.Decimal128, default: 0.0 },
    ownershipStatus: {
        type: String,
        enum: ['Owned', 'Leased', 'Rented']
    },
    purchaseDate: Date,
    leaseExpiryDate: Date,
    assignedDepartment: String,

    vehicleUsage: {
        type: String,
        enum: ['Passenger Transport', 'Delivery', 'Maintenance', 'Administrative', 'Other']
    },
    availabilityStatus: {
        type: String,
        enum: ['Available', 'In Use', 'Under Maintenance', 'Out of Service']
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('vehicle', vehicleSchema);