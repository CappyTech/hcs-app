'use strict';

/**
 * Format validation for UK tax identifiers used in CIS and payroll.
 * These are format checks only — they do not verify identifiers with HMRC.
 */

// NINO: two prefix letters (D, F, I, Q, U, V never appear; O not allowed as
// second letter; BG/GB/NK/KN/TN/NT/ZZ are reserved), six digits, suffix A–D.
const NINO_REGEX = /^(?!BG|GB|NK|KN|TN|NT|ZZ)[ABCEGHJ-PRSTW-Z][ABCEGHJ-NPRSTW-Z]\d{6}[A-D]$/;

/** Uppercase and strip all whitespace. */
function normalise(value) {
  return String(value ?? '').toUpperCase().replace(/\s/g, '');
}

/** Unique Taxpayer Reference: 10 digits (a trailing K from older formats is tolerated). */
function isValidUtr(value) {
  return /^\d{10}K?$/.test(normalise(value));
}

/** National Insurance number, e.g. AB123456C. */
function isValidNino(value) {
  return NINO_REGEX.test(normalise(value));
}

/** CIS verification number, e.g. V1234567890, V1234567890A or V1234567890AB. */
function isValidVerificationNumber(value) {
  return /^V\d{10}[A-Z]{0,2}$/.test(normalise(value));
}

module.exports = {
  normalise,
  isValidUtr,
  isValidNino,
  isValidVerificationNumber,
};
