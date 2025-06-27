const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const encryptionService = require('../../../services/encryptionService');
const { v4: uuidv4 } = require('uuid');
const { Schema } = mongoose;

const userSchema = new Schema({
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    role: {
        type: String,
        enum: ['subcontractor', 'employee', 'accountant', 'hmrc', 'admin', 'client'],
        default: 'subcontractor'
    },
    subcontractorId: {
        type: Schema.Types.ObjectId,
        ref: 'supplier',
        default: null
    },
    clientId: {
        type: Schema.Types.ObjectId,
        ref: 'customer',
        default: null
    },
    employeeId: {
        type: Schema.Types.ObjectId,
        ref: 'employee',
        default: null
    },
    totpSecret: {
        type: String,
        get: (v) => (v ? encryptionService.decrypt(v) : null),
        set: (v) => (v ? encryptionService.encrypt(v) : undefined)
    },
    totpEnabled: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

// Hash password before save
userSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }

    // Ensure only one of the foreign keys is set
    const count = [this.subcontractorId, this.clientId, this.employeeId].filter(Boolean).length;
    if (count > 1) {
        return next(new Error('User can only be linked to one of subcontractor, client, or employee.'));
    }

    next();
});

module.exports = mongoose.model('user', userSchema);
