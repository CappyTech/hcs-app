'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * payrollSubmission — record of an HMRC RTI or People's Pension submission.
 *
 * Created whenever an FPS or EPS XML is generated (status='generated') and
 * updated when submitted to the HMRC Government Gateway or the pension portal.
 *
 * The xmlPayload is stored verbatim for audit / re-submission purposes.
 */
const payrollSubmissionSchema = new mongoose.Schema({
  uuid: {
    type: String,
    unique: true,
    required: true,
    default: () => crypto.randomUUID()
  },

  // ── Classification ────────────────────────────────────────────────────────
  type: {
    type: String,
    enum: ['FPS', 'EPS'],
    required: true
  },

  taxYear:  { type: String, required: true },  // e.g. '2025/26'
  taxMonth: { type: Number, min: 1, max: 12 }, // null for FPS (which is weekly/fortnightly)
  taxWeek:  { type: Number, min: 1, max: 56 },

  // FPS submissions link to a run; EPS may be standalone
  runId: { type: mongoose.Schema.Types.ObjectId, ref: 'payrollRun', default: null },

  // ── Payload & status ──────────────────────────────────────────────────────
  xmlPayload: { type: String, default: null },  // full XML string, stored for audit trail

  status: {
    type: String,
    enum: ['generated', 'submitted', 'accepted', 'rejected'],
    default: 'generated'
  },

  submittedAt: { type: Date, default: null },

  // HMRC Government Gateway correlation ID (from response envelope)
  hmrcCorrelationId: { type: String, default: null },

  // Raw XML response body from HMRC (success or error detail)
  hmrcResponse: { type: String, default: null },

  // Parsed error messages extracted from hmrcResponse for display
  errorMessages: [{ type: String }]
}, {
  timestamps: true
});

payrollSubmissionSchema.index({ taxYear: 1, type: 1 });
payrollSubmissionSchema.index({ runId: 1 });
payrollSubmissionSchema.index({ status: 1 });

module.exports = {
  modelName: 'payrollSubmission',
  schema: payrollSubmissionSchema
};
