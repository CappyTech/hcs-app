'use strict';

const mongoose = require('mongoose');

// Singleton document — only one letterhead config exists per installation.
// Use Letterhead.findOneAndUpdate({}, data, { upsert: true }) to save.
const letterheadSchema = new mongoose.Schema({
  companyName:       { type: String, trim: true, default: '' },
  tagline:           { type: String, trim: true, default: '' },
  addressLine1:      { type: String, trim: true, default: '' },
  addressLine2:      { type: String, trim: true, default: '' },
  town:              { type: String, trim: true, default: '' },
  county:            { type: String, trim: true, default: '' },
  postcode:          { type: String, trim: true, default: '' },
  phone:             { type: String, trim: true, default: '' },
  email:             { type: String, trim: true, default: '' },
  website:           { type: String, trim: true, default: '' },
  registrationNumber:{ type: String, trim: true, default: '' },
  vatNumber:         { type: String, trim: true, default: '' },
  logoPath:          { type: String, trim: true, default: '' },
  footerText:        { type: String, trim: true, default: '' },
}, {
  timestamps: true,
});

module.exports = {
  modelName: 'letterhead',
  schema: letterheadSchema,
};
