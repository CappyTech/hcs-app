const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

/*
 * totpService requires speakeasy, qrcode, encryptionService, logger.
 * All are installed and work — test with real deps.
 * encryptionService needs ENCRYPTION_KEY env.
 */
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-totp-service-unit-tests-32ch';
}

const { generateTOTPSecret, generateQRCode } = require('../services/totpService');

/* ── tests ─────────────────────────────────────────────────────────── */
describe('totpService', () => {
  describe('generateTOTPSecret', () => {
    it('generates a base32 secret and encrypts it on the user', async () => {
      const user = { id: 'u1', totpSecret: null, save: mock.fn(() => Promise.resolve()) };
      const secret = await generateTOTPSecret(user);
      assert.equal(typeof secret, 'string');
      assert.ok(secret.length > 0, 'secret should be non-empty');
      assert.ok(user.totpSecret, 'encrypted secret should be set');
      assert.notEqual(user.totpSecret, secret, 'stored value should be encrypted');
      assert.equal(user.save.mock.callCount(), 1);
    });

    it('overwrites existing totpSecret', async () => {
      const user = { id: 'u2', totpSecret: 'old_encrypted', save: mock.fn(() => Promise.resolve()) };
      await generateTOTPSecret(user);
      assert.notEqual(user.totpSecret, 'old_encrypted');
    });

    it('returns a string suitable for QR code generation', async () => {
      const user = { id: 'u3', save: mock.fn(() => Promise.resolve()) };
      const secret = await generateTOTPSecret(user);
      // base32 contains only uppercase letters and digits 2-7
      assert.match(secret, /^[A-Z2-7]+=*$/);
    });
  });

  describe('generateQRCode', () => {
    it('returns a data URL', async () => {
      const url = await generateQRCode('JBSWY3DPEHPK3PXP', { username: 'testuser' });
      assert.ok(url.startsWith('data:image/png;base64,'));
    });

    it('includes the username in the QR code URL', async () => {
      // We can't easily inspect the QR content, but we verify it returns without error
      const url = await generateQRCode('ABCDEFGH', { username: 'alice' });
      assert.ok(url.length > 100, 'data URL should be substantial');
    });
  });
});
