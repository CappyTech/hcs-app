const mongoose = require('mongoose');
const crypto = require('crypto');

const locationSchema = new mongoose.Schema({
  uuid: {
    type: String,
    default: () => crypto.randomUUID(),
    unique: true,
    required: true
  },
  name: {
    type: String,
    trim: true,
    default: null
  },
  address: {
    type: String,
    trim: true,
    default: null
  },
  city: {
    type: String,
    trim: true,
    default: null
  },
  postalCode: {
    type: String,
    trim: true,
    default: null
  },
  country: {
    type: String,
    trim: true,
    default: null
  },
  latitude: {
    type: Number,
    default: null
  },
  longitude: {
    type: Number,
    default: null
  }
}, {
  timestamps: true
});

locationSchema.pre('validate', function (next) {
  if (!this.name && !this.address && !this.city && !this.postalCode && !this.country) {
    return next(new Error('At least one of name, address, city, postalCode, or country must be provided.'));
  }
  next();
});

module.exports = {
  modelName: 'location',
  schema: locationSchema
};
