import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// encryptionService requires ENCRYPTION_KEY at load time
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
}
// Dynamic import so the env assignment above runs first (static imports hoist).
const { encrypt, decrypt } = await import('../services/encryptionService.js');
import crypto from 'node:crypto';

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

  describe('encrypt output format (v2 / AES-256-GCM)', () => {
    it('returns v2:iv:authTag:ciphertext (all base64)', () => {
      const result = encrypt('test');
      const parts = result.split(':');
      assert.equal(parts.length, 4);
      assert.equal(parts[0], 'v2');
      assert.ok(parts[1].length > 0, 'IV should be non-empty');
      assert.ok(parts[2].length > 0, 'auth tag should be non-empty');
      assert.ok(parts[3].length > 0, 'ciphertext should be non-empty');
    });

    it('IV decodes to 12 bytes (GCM)', () => {
      const result = encrypt('test');
      const ivBuf = Buffer.from(result.split(':')[1], 'base64');
      assert.equal(ivBuf.length, 12);
    });

    it('auth tag decodes to 16 bytes', () => {
      const result = encrypt('test');
      const tagBuf = Buffer.from(result.split(':')[2], 'base64');
      assert.equal(tagBuf.length, 16);
    });
  });

  describe('legacy AES-256-CBC compatibility', () => {
    // Re-create the legacy format so we can prove old ciphertexts still decrypt.
    function legacyEncrypt(text) {
      const key = crypto.scryptSync(process.env.ENCRYPTION_KEY, 'salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(text, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      return iv.toString('base64') + ':' + encrypted;
    }

    it('decrypts a legacy CBC ciphertext', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      assert.equal(decrypt(legacyEncrypt(secret)), secret);
    });

    it('decrypts legacy unicode content', () => {
      const text = '日本語テスト 🔑';
      assert.equal(decrypt(legacyEncrypt(text)), text);
    });
  });

  describe('tamper detection (GCM)', () => {
    it('throws when ciphertext is modified', () => {
      const parts = encrypt('secret').split(':');
      const ctBuf = Buffer.from(parts[3], 'base64');
      ctBuf[0] ^= 0xff;
      parts[3] = ctBuf.toString('base64');
      assert.throws(() => decrypt(parts.join(':')), /failed/i);
    });

    it('throws when auth tag is modified', () => {
      const parts = encrypt('secret').split(':');
      const tagBuf = Buffer.from(parts[2], 'base64');
      tagBuf[0] ^= 0xff;
      parts[2] = tagBuf.toString('base64');
      assert.throws(() => decrypt(parts.join(':')), /failed/i);
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
