'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * payrollConfig — singleton company-level PAYE payroll configuration.
 *
 * Sensitive credential fields (payeSchemeReference, gatewayUserId,
 * gatewayPassword) are stored as AES-256-CBC ciphertext via encryptionService.
 * The model itself is just a plain String — encryption/decryption is the
 * responsibility of the service layer reading/writing these fields.
 *
 * There should be exactly ONE document per deployment.  The controller
 * uses findOneAndUpdate with upsert:true to enforce this.
 */
const payrollConfigSchema = new mongoose.Schema({
  uuid: {
    type: String,
    unique: true,
    required: true,
    default: () => crypto.randomUUID()
  },

  // ── HMRC PAYE ─────────────────────────────────────────────────────────────
  // Stored as encrypted ciphertext via encryptionService.encrypt()
  payeSchemeReference:  { type: String, default: null }, // e.g. '123/AB12345' (encrypted)
  gatewayUserId:        { type: String, default: null }, // Government Gateway user ID (encrypted)
  gatewayPassword:      { type: String, default: null }, // Government Gateway password (encrypted)
  accountsOfficeRef:    { type: String, default: null }, // e.g. '123PA00012345' — for EPS

  employerName:    { type: String, default: null },
  contactName:     { type: String, default: null },
  contactPhone:    { type: String, default: null },
  contactEmail:    { type: String, default: null },

  // ── Pension ───────────────────────────────────────────────────────────────
  defaultEmployeePensionRate: { type: mongoose.Decimal128, default: 5.0 },  // %
  defaultEmployerPensionRate: { type: mongoose.Decimal128, default: 3.0 },  // %
  pensionProviderName:        { type: String, default: "People's Pension" },
  pensionEmployerRef:         { type: String, default: null },              // encrypted

  // ── KashFlow nominal code mappings ────────────────────────────────────────
  kashflowNominals: {
    grossWages:    { type: Number, default: null }, // Dr Wages Expense
    employerNI:    { type: Number, default: null }, // Dr Employer NI Expense
    employerPension: { type: Number, default: null }, // Dr Employer Pension Expense
    payeNiControl: { type: Number, default: null }, // Cr HMRC PAYE & NI Liability
    netPayControl: { type: Number, default: null }, // Cr Net Wages Payable
    pensionControl: { type: Number, default: null }, // Cr Pension Contributions Payable
    bankNominal:   { type: Number, default: null }  // Dr/Cr Bank (for cleared payments)
  }
}, {
  timestamps: true
});

module.exports = {
  modelName: 'payrollConfig',
  schema: payrollConfigSchema
};
