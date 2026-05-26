'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

// UK GDPR Art. 15–22 request types
const REQUEST_TYPES = [
  'access',        // Art. 15 — Subject Access Request
  'rectification', // Art. 16 — Correct inaccurate personal data
  'erasure',       // Art. 17 — Right to be forgotten
  'restriction',   // Art. 18 — Restrict processing
  'portability',   // Art. 20 — Receive data in portable format
  'objection',     // Art. 21 — Object to processing
];

const REQUEST_STATUSES = [
  'pending',       // Submitted, awaiting triage
  'under_review',  // Assigned and being assessed
  'approved',      // Approved — action in progress
  'rejected',      // Rejected with reason
  'completed',     // Fully actioned and closed
  'withdrawn',     // Withdrawn by the data subject
];

// Immutable audit trail entry (no _id to keep docs lean)
const evidenceEntrySchema = new mongoose.Schema(
  {
    action:  { type: String, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    notes:   { type: String, trim: true },
    at:      { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const gdprRequestSchema = new mongoose.Schema(
  {
    uuid: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomUUID(),
    },

    // The data subject who submitted this request
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },

    type:   { type: String, enum: REQUEST_TYPES,   required: true },
    status: { type: String, enum: REQUEST_STATUSES, default: 'pending', index: true },

    // Free-text description supplied by the data subject
    description: { type: String, trim: true, maxlength: 2000 },

    // Admin-only notes (never shown to the requester in pending state)
    adminNotes: { type: String, trim: true, maxlength: 2000 },

    // The admin who actioned this request — must differ from requestedBy
    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
    reviewedAt:  { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // 30-calendar-day deadline per UK GDPR Art. 12(3); auto-set on create
    deadline: { type: Date },

    // Immutable append-only audit trail
    evidenceLog: { type: [evidenceEntrySchema], default: [] },
  },
  { timestamps: true },
);

// Auto-set 30-day response deadline on first save
gdprRequestSchema.pre('save', function (next) {
  if (this.isNew && !this.deadline) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    this.deadline = d;
  }
  next();
});

// Core separation-of-duties guard: a user may never review their own request.
// This runs on every save so it cannot be bypassed by a direct findOneAndUpdate.
gdprRequestSchema.pre('save', function (next) {
  if (
    this.reviewedBy &&
    String(this.reviewedBy) === String(this.requestedBy)
  ) {
    return next(new Error('A user may not review their own GDPR request.'));
  }
  next();
});

// Compound index: admin dashboard sorted by status + date
gdprRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = { modelName: 'gdprRequest', schema: gdprRequestSchema };
