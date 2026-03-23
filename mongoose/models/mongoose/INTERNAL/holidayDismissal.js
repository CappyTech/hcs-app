const mongoose = require('mongoose');
const crypto = require('crypto');

const holidayDismissalSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    holidayId: { type: mongoose.Schema.Types.ObjectId, ref: 'holiday', required: true },
    dismissedAt: { type: Date, default: Date.now }
}, {
    timestamps: true
});

holidayDismissalSchema.index({ userId: 1, holidayId: 1 }, { unique: true });

module.exports = {
    modelName: 'holidayDismissal',
    schema: holidayDismissalSchema
};
