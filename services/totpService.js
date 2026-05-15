const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const encryptionService = require("./encryptionService");
const logger = require("./loggerService");

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
  const totpSecret = speakeasy.generateSecret({ length: 20 }); // Generate a 20-character secret
  const secret = totpSecret.base32; // Retrieve the Base32-encoded secret

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
  const otpAuthUrl = speakeasy.otpauthURL({
    secret: secret, // Base32 TOTP secret
    label: `${user.username} - HeronCS LTD`, // Label for the QR code (e.g., username and issuer)
    issuer: "HeronCS LTD", // Issuer name (displayed in the authenticator app)
    encoding: "base32",
  });
  return await qrcode.toDataURL(otpAuthUrl); // Generate a QR code as a Base64 data URL
};

module.exports = {
  generateQRCode,
  generateTOTPSecret,
};
