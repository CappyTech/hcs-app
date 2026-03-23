const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const encryptionService = require('../../../../services/encryptionService');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
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
        enum: ['none', 'subcontractor', 'employee', 'accountant', 'hmrc', 'admin', 'client'],
        default: 'none'
    },
    subcontractorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'supplier',
        default: null
    },
    clientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'customer',
        default: null
    },
    employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'employee',
        default: null
    },
    emailVerified: {
        type: Boolean,
        default: false
    },
    emailVerificationToken: {
        type: String,
        default: null
    },
    emailVerificationExpires: {
        type: Date,
        default: null
    },
    totpSecret: {
        type: String,
        // NOTE: The getter/setter auto-encrypts on write and auto-decrypts on read.
        // totpService.generateTOTPSecret and the controllers ALSO call encrypt/decrypt
        // manually, resulting in double encryption at rest. This works because the two
        // layers are symmetrically applied, but callers should be aware of the pattern.
        get: (v) => (v ? encryptionService.decrypt(v) : null),
        set: (v) => (v ? encryptionService.encrypt(v) : undefined)
    },
    totpEnabled: {
        type: Boolean,
        default: false
    },
    customPermissions: {
        departments: { type: [String], default: [] },
        models: { type: Map, of: String, default: () => new Map() },
        routes: { type: [String], default: [] }
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

    // clientId is mutually exclusive with employeeId/subcontractorId.
    // employeeId + subcontractorId may coexist (IR35 off-payroll workers).
    if (this.clientId && (this.employeeId || this.subcontractorId)) {
        return next(new Error('A client user cannot also be linked as an employee or subcontractor.'));
    }

    next();
});

module.exports = {
    modelName: 'user',
    schema: userSchema
};
