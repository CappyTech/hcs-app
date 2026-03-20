const crypto = require("crypto");
require("dotenv").config();

// Validate environment variable
if (!process.env.ENCRYPTION_KEY) {
  throw new Error("ENCRYPTION_KEY is not set in the environment variables");
}

const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.ENCRYPTION_KEY,
  "salt",
  32,
); // Derive a 256-bit key
const IV_LENGTH = 16; // AES block size is 16 bytes

/**
 * Encrypts a given text using AES-256-CBC encryption algorithm.
 *
 * @param {string} text - The text to encrypt.
 * @returns {string} - The encrypted text in Base64 format, prefixed with the IV.
 * @throws {Error} - Throws an error if the text is invalid.
 */
function encrypt(text) {
  try {
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("Invalid text for encryption");
    }

    const iv = crypto.randomBytes(IV_LENGTH); // Generate a random 16-byte IV
    const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, "utf8", "base64"); // Encode the encrypted data as Base64
    encrypted += cipher.final("base64");
    return iv.toString("base64") + ":" + encrypted; // Combine IV (Base64) and encrypted text (Base64)
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Decrypts a given encrypted text using AES-256-CBC encryption algorithm.
 *
 * @param {string} encryptedText - The encrypted text in Base64 format, prefixed with the IV.
 * @returns {string} - The decrypted text.
 * @throws {Error} - Throws an error if the input is invalid or decryption fails.
 */
function decrypt(encryptedText) {
  try {
    if (typeof encryptedText !== "string" || !encryptedText.includes(":")) {
      throw new Error("Invalid encrypted text format");
    }

    const [ivBase64, encrypted] = encryptedText.split(":"); // Split IV and encrypted text
    const iv = Buffer.from(ivBase64, "base64"); // Decode the IV from Base64

    if (iv.length !== IV_LENGTH) {
      throw new Error("Invalid initialization vector");
    }

    const encryptedBuffer = Buffer.from(encrypted, "base64"); // Decode the encrypted text from Base64
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedBuffer, "base64", "utf8"); // Decode during decryption
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
