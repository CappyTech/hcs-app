import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * totpService requires otplib, qrcode, encryptionService, logger.
 * otplib and encryptionService run with real deps.
 * qrcode is stubbed: its toDataURL() uses native/canvas internals that
 * produce non-cloneable objects, causing the Node test-runner IPC channel
 * to fail with ERR_TEST_FAILURE / "Unable to deserialize cloned data".
 * Stubbing before totpService loads ensures the CJS require cache delivers
 * the same patched instance to totpService.
 */
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-totp-service-unit-tests-32ch';
}

// Patch qrcode BEFORE totpService is required so it picks up the stub.
import qrcode from 'qrcode';
const FAKE_QR_URL = 'data:image/png;base64,' + 'A'.repeat(128);
mock.method(qrcode, 'toDataURL', async () => FAKE_QR_URL);

// Dynamic import so the env assignment and qrcode stub above run first
// (static imports hoist).
const { generateTOTPSecret, generateQRCode, verifyTOTP } = await import('../services/totpService.js');
import { authenticator } from 'otplib';

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

    it('returns the value from qrcode.toDataURL', async () => {
      const url = await generateQRCode('ABCDEFGH', { username: 'alice' });
      assert.equal(url, FAKE_QR_URL);
    });
  });

  describe('verifyTOTP', () => {
    const secret = 'JBSWY3DPEHPK3PXP';

    it('accepts the current token for the secret', () => {
      const token = authenticator.generate(secret);
      assert.equal(verifyTOTP(secret, token), true);
    });

    it('accepts a token with surrounding whitespace', () => {
      const token = authenticator.generate(secret);
      assert.equal(verifyTOTP(secret, `  ${token}  `), true);
    });

    it('rejects a wrong token', () => {
      const token = authenticator.generate(secret);
      const wrong = token === '000000' ? '000001' : '000000';
      assert.equal(verifyTOTP(secret, wrong), false);
    });

    it('rejects a token generated for a different secret', () => {
      const otherToken = authenticator.generate('MFRGGZDFMZTWQ2LK');
      const ours = authenticator.generate(secret);
      // In the astronomically unlikely event both secrets yield the same
      // token this period, skip rather than flake.
      if (otherToken === ours) return;
      assert.equal(verifyTOTP(secret, otherToken), false);
    });

    it('accepts the previous time-step token (window ±1 clock drift)', () => {
      const drifted = authenticator.clone({ epoch: Date.now() - 30000 }).generate(secret);
      assert.equal(verifyTOTP(secret, drifted), true);
    });

    it('returns false for missing inputs instead of throwing', () => {
      assert.equal(verifyTOTP(null, '123456'), false);
      assert.equal(verifyTOTP(secret, ''), false);
      assert.equal(verifyTOTP('', ''), false);
    });

    it('returns false (not throw) for a malformed secret', () => {
      assert.equal(verifyTOTP('not-base32-???', '123456'), false);
    });
  });
});
