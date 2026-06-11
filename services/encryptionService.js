const crypto = require("crypto");
require("dotenv").config();

// Validate environment variable
if (!process.env.ENCRYPTION_KEY) {
  throw new Error("ENCRYPTION_KEY is not set in the environment variables");
}

// Key derivation salt. Defaults to the historical value so existing ciphertexts
// (TOTP secrets) remain decryptable. New deployments should set ENCRYPTION_SALT
// to a unique random value; changing it on an existing deployment requires
// re-encrypting all stored secrets.
const KEY_SALT = process.env.ENCRYPTION_SALT || "salt";

const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.ENCRYPTION_KEY,
  KEY_SALT,
  32,
); // Derive a 256-bit key
const IV_LENGTH = 16; // Legacy CBC IV size
const GCM_IV_LENGTH = 12; // Recommended IV size for GCM
const V2_PREFIX = "v2";

/**
 * Encrypts a given text using AES-256-GCM (authenticated encryption).
 *
 * @param {string} text - The text to encrypt.
 * @returns {string} - "v2:<iv>:<authTag>:<ciphertext>" (all Base64).
 * @throws {Error} - Throws an error if the text is invalid.
 */
function encrypt(text) {
  try {
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("Invalid text for encryption");
    }

    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([
      cipher.update(text, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      V2_PREFIX,
      iv.toString("base64"),
      authTag.toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypts text produced by encrypt(). Supports both the current AES-256-GCM
 * format ("v2:iv:tag:ciphertext") and the legacy AES-256-CBC format
 * ("iv:ciphertext") so secrets encrypted before the GCM migration keep working.
 *
 * @param {string} encryptedText - The encrypted text.
 * @returns {string} - The decrypted text.
 * @throws {Error} - Throws an error if the input is invalid or decryption fails.
 */
function decrypt(encryptedText) {
  try {
    if (typeof encryptedText !== "string" || !encryptedText.includes(":")) {
      throw new Error("Invalid encrypted text format");
    }

    const parts = encryptedText.split(":");

    if (parts[0] === V2_PREFIX) {
      if (parts.length !== 4) {
        throw new Error("Invalid encrypted text format");
      }
      const iv = Buffer.from(parts[1], "base64");
      const authTag = Buffer.from(parts[2], "base64");
      const encryptedBuffer = Buffer.from(parts[3], "base64");
      if (iv.length !== GCM_IV_LENGTH) {
        throw new Error("Invalid initialization vector");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedBuffer),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    }

    // Legacy AES-256-CBC format: "<iv>:<ciphertext>" (both Base64)
    const [ivBase64, encrypted] = parts;
    const iv = Buffer.from(ivBase64, "base64");

    if (iv.length !== IV_LENGTH) {
      throw new Error("Invalid initialization vector");
    }

    const encryptedBuffer = Buffer.from(encrypted, "base64");
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedBuffer, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

module.exports = {
  encrypt,
  decrypt,
};
