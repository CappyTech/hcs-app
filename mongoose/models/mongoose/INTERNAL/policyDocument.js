'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const policyDocumentSchema = new mongoose.Schema({
  uuid:        { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  title:       { type: String, required: true, trim: true },
  category:    {
    type: String,
    trim: true,
    enum: ['HR', 'Health & Safety', 'GDPR', 'Finance', 'Operations', 'General'],
    default: 'General',
  },
  version:     { type: String, trim: true, default: '1.0' },
  contentHtml: { type: String, default: '' },
  isPublished: { type: Boolean, default: false, index: true },
  // Next scheduled review — policyReviewReminderService emails admins as this approaches
  reviewDate:  { type: Date, default: null },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
}, {
  timestamps: true,
});

module.exports = {
  modelName: 'policyDocument',
  schema: policyDocumentSchema,
};
