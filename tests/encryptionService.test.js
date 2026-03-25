const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// encryptionService requires ENCRYPTION_KEY at load time
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
}
const { encrypt, decrypt } = require('../services/encryptionService');

describe('encryptionService', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('round-trips a simple string', () => {
      const original = 'hello world';
      const encrypted = encrypt(original);
      assert.notEqual(encrypted, original);
      assert.equal(decrypt(encrypted), original);
    });

    it('round-trips a TOTP secret', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      assert.equal(decrypt(encrypt(secret)), secret);
    });

    it('round-trips unicode characters', () => {
      const text = '日本語テスト 🔑';
      assert.equal(decrypt(encrypt(text)), text);
    });

    it('round-trips a long string', () => {
      const text = 'A'.repeat(10000);
      assert.equal(decrypt(encrypt(text)), text);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const text = 'same input';
      const a = encrypt(text);
      const b = encrypt(text);
      assert.notEqual(a, b);
    });
  });

  describe('encrypt output format', () => {
    it('returns base64 IV : base64 ciphertext', () => {
      const result = encrypt('test');
      assert.ok(result.includes(':'), 'should contain : separator');
      const [iv, cipher] = result.split(':');
      assert.ok(iv.length > 0, 'IV should be non-empty');
      assert.ok(cipher.length > 0, 'ciphertext should be non-empty');
    });

    it('IV decodes to 16 bytes', () => {
      const result = encrypt('test');
      const ivBase64 = result.split(':')[0];
      const ivBuf = Buffer.from(ivBase64, 'base64');
      assert.equal(ivBuf.length, 16);
    });
  });

  describe('encrypt validation', () => {
    it('throws on empty string', () => {
      assert.throws(() => encrypt(''), /Invalid text|failed/i);
    });

    it('throws on whitespace-only string', () => {
      assert.throws(() => encrypt('   '), /Invalid text|failed/i);
    });

    it('throws on non-string input', () => {
      assert.throws(() => encrypt(123), /Invalid text|failed/i);
    });

    it('throws on null', () => {
      assert.throws(() => encrypt(null), /Invalid text|failed/i);
    });
  });

  describe('decrypt validation', () => {
    it('throws on string without colon separator', () => {
      assert.throws(() => decrypt('noseparator'), /Invalid|failed/i);
    });

    it('throws on non-string input', () => {
      assert.throws(() => decrypt(42), /Invalid|failed/i);
    });

    it('throws on tampered ciphertext', () => {
      const encrypted = encrypt('secret');
      const [iv] = encrypted.split(':');
      assert.throws(() => decrypt(`${iv}:AAAA`), /failed/i);
    });

    it('throws on invalid IV length', () => {
      assert.throws(() => decrypt('AAAA:BBBB'), /failed/i);
    });
  });
});
