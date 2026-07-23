import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import encryptionService from './encryptionService.js';
import logger from './loggerService.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

/**
 * Generates a TOTP (Time-Based One-Time Password) secret for a user, encrypts it,
 * and saves it to the user's record in the database.
 *
 * @param {Object} user - The user object from the database.
 * @param {string} user.id - The unique identifier of the user.
 * @param {string} [user.totpSecret] - The user's existing TOTP secret, if any.
 *
 * @returns {string} - The newly generated TOTP secret in Base32 encoding.
 */
const generateTOTPSecret = async (user) => {
  const secret = authenticator.generateSecret(20); // Base32-encoded, 20 bytes of entropy

  // Encrypt and store the secret
  user.totpSecret = encryptionService.encrypt(secret);
  await user.save();

  logger.info(`[totpService] Generated and encrypted TOTP Secret for user ${user.id}`);
  return secret; // Return the Base32 secret for QR code generation or manual input
};

/**
 * Generates a QR code URL for a TOTP (Time-Based One-Time Password) setup using a secret.
 *
 * @param {string} secret - The TOTP secret in Base32 encoding.
 * @param {Object} user - The user object for whom the QR code is generated.
 * @param {string} user.username - The username of the user, included in the QR label.
 *
 * @returns {Promise<string>} - A Promise that resolves to the QR code data URL (Base64-encoded PNG).
 */
const generateQRCode = async (secret, user) => {
  const otpAuthUrl = authenticator.keyuri(
    `${user.username} - HeronCS LTD`, // account label (shown in the authenticator app)
    "HeronCS LTD",                    // issuer
    secret                            // Base32 TOTP secret
  );
  return await qrcode.toDataURL(otpAuthUrl); // Generate a QR code as a Base64 data URL
};

/**
 * Verify a 6-digit TOTP token against a Base32 secret.
 *
 * Single verification chokepoint for the whole app (login 2FA, SSO, settings,
 * sensitive-action confirmation). Accepts the previous/next time step
 * (window ±1, matching the old speakeasy behaviour) to tolerate clock drift.
 *
 * @param {string} secret - Base32 TOTP secret (already decrypted).
 * @param {string} token  - The 6-digit code entered by the user.
 * @returns {boolean}
 */
const verifyTOTP = (secret, token) => {
  if (!secret || !token) return false;
  try {
    const verifier = authenticator.clone({ window: 1 });
    return verifier.verify({ secret, token: String(token).trim() });
  } catch (err) {
    logger.warn(`[totpService] TOTP verification error: ${err.message}`);
    return false;
  }
};

/**
 * Generate one-time 2FA recovery codes.
 * Returns the plaintext codes (shown to the user exactly once) and bcrypt
 * hashes for storage on user.totpBackupCodes.
 *
 * @param {number} [count=10]
 * @returns {Promise<{ plain: string[], hashed: string[] }>}
 */
const generateBackupCodes = async (count = 10) => {
  const plain = Array.from({ length: count }, () => {
    // 10 hex chars grouped as XXXXX-XXXXX for readability
    const hex = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
  const hashed = await Promise.all(plain.map((c) => bcrypt.hash(normalizeBackupCode(c), 10)));
  return { plain, hashed };
};

/** Canonical form for comparing backup codes (case/dash/space-insensitive). */
const normalizeBackupCode = (input) =>
  String(input || "").replace(/[\s-]/g, "").toUpperCase();

/**
 * Check `input` against the stored hashes; on a match, consume it.
 * @returns {Promise<{ ok: boolean, remaining: string[] }>} remaining hashes after use
 */
const verifyAndConsumeBackupCode = async (input, hashedCodes = []) => {
  const normalized = normalizeBackupCode(input);
  if (normalized.length < 8) return { ok: false, remaining: hashedCodes };
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(normalized, hashedCodes[i])) {
      return { ok: true, remaining: hashedCodes.filter((_, idx) => idx !== i) };
    }
  }
  return { ok: false, remaining: hashedCodes };
};

export default {
  generateQRCode,
  generateTOTPSecret,
  verifyTOTP,
  generateBackupCodes,
  normalizeBackupCode,
  verifyAndConsumeBackupCode,
};

export { generateQRCode, generateTOTPSecret, verifyTOTP, generateBackupCodes, normalizeBackupCode, verifyAndConsumeBackupCode };
