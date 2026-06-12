'use strict';

const axios = require('axios');
const crypto = require('crypto');
const logger = require('./loggerService');

/**
 * Have I Been Pwned breached-password check (k-anonymity model).
 *
 * Only the first five characters of the password's SHA-1 hash are sent to the
 * API — the password itself never leaves the server. The check FAILS OPEN: if
 * the API is unreachable (or HIBP_DISABLED=true), the password is accepted and
 * `checked: false` is returned, so an outage can never block logins/resets.
 */

const API_BASE = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 4000;

const PWNED_MESSAGE =
  'That password has appeared in a known data breach and cannot be used. Please choose a different password.';

async function fetchRange(prefix) {
  const res = await axios.get(API_BASE + prefix, {
    timeout: TIMEOUT_MS,
    // Padding hides which range sizes we query, hardening the k-anonymity model
    headers: { 'Add-Padding': 'true' },
    responseType: 'text',
    transformResponse: [(data) => data],
  });
  return res.data;
}

/** Parse a range response ("SUFFIX:COUNT" lines) and return the count for `suffix`. */
function countInRange(body, suffix) {
  for (const line of String(body || '').split(/\r?\n/)) {
    const [hashSuffix, count] = line.trim().split(':');
    if (hashSuffix === suffix) return parseInt(count, 10) || 0;
  }
  return 0;
}

/**
 * @param {string} password
 * @param {object} [opts]
 * @param {Function} [opts.fetch] – range fetcher override (tests)
 * @returns {Promise<{pwned: boolean, count: number, checked: boolean}>}
 */
async function isPasswordPwned(password, { fetch = fetchRange } = {}) {
  if (String(process.env.HIBP_DISABLED || '').toLowerCase() === 'true') {
    return { pwned: false, count: 0, checked: false };
  }
  try {
    const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
    const body = await fetch(sha1.slice(0, 5));
    const count = countInRange(body, sha1.slice(5));
    return { pwned: count > 0, count, checked: true };
  } catch (err) {
    logger.warn('[hibp] Breach check unavailable (failing open): ' + err.message);
    return { pwned: false, count: 0, checked: false };
  }
}

module.exports = {
  isPasswordPwned,
  countInRange,
  PWNED_MESSAGE,
};
