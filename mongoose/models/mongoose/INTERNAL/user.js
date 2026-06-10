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
    phoneNumber: {
        type: String,
        default: null,
        trim: true,
        sparse: true,
        unique: true
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
    passwordResetToken: {
        type: String,
        default: null
    },
    passwordResetExpires: {
        type: Date,
        default: null
    },
    smsResetOtp: {
        type: String,
        default: null
    },
    smsResetExpires: {
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
    },
    loginAttempts: {
        type: Number,
        default: 0
    },
    lockedUntil: {
        type: Date,
        default: null
    }
}, {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
});

// Hash password before save.
// Guard: if the value already looks like a bcrypt hash (set by a controller that
// pre-hashes before calling save) skip re-hashing to prevent double-hashing.
userSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        const alreadyHashed = typeof this.password === 'string' && this.password.startsWith('$2');
        if (!alreadyHashed) {
            const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 12;
            this.password = await bcrypt.hash(this.password, saltRounds);
        }
    }

    // Ensure only one of the foreign keys is set
    const count = [this.subcontractorId, this.clientId, this.employeeId].filter(Boolean).length;
    if (count > 1) {
        return next(new Error('User can only be linked to one of subcontractor, client, or employee.'));
    }

    next();
});

module.exports = {
    modelName: 'user',
    schema: userSchema
};
