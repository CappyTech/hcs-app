'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

// Single source of truth for category options (consumed by the form + grouping).
const POLICY_CATEGORIES = [
  'HR',
  'Health & Safety',
  'GDPR',
  'Finance',
  'Operations',
  'Employee Handbook',
  'Employee Contract',
  'Onboarding',
  'General',
];

const policyDocumentSchema = new mongoose.Schema({
  uuid:        { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  title:       { type: String, required: true, trim: true },
  category:    {
    type: String,
    trim: true,
    enum: POLICY_CATEGORIES,
    default: 'General',
  },
  // Optional owner: when set, this is an individual document for one employee
  // (e.g. contract, onboarding pack). When null, it is a company-wide policy.
  employee:    { type: mongoose.Schema.Types.ObjectId, ref: 'employee', default: null, index: true },
  version:     { type: String, trim: true, default: '1.0' },
  contentHtml: { type: String, default: '' },
  isPublished: { type: Boolean, default: false, index: true },
  // Review cadence rule: the policy is treated as out of date this many months
  // after its last update unless an explicit reviewDate is set. 0 = never expires.
  reviewIntervalMonths: { type: Number, default: 12, min: 0 },
  // How many days before the review date the policy is flagged "due soon".
  reviewWarningDays: { type: Number, default: 30, min: 0 },
  // Next scheduled review — policyReviewReminderService emails admins as this
  // approaches. Auto-derived from reviewIntervalMonths on save when not set.
  reviewDate:  { type: Date, default: null },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
}, {
  timestamps: true,
});

module.exports = {
  modelName: 'policyDocument',
  schema: policyDocumentSchema,
  POLICY_CATEGORIES,
};
