import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// totpService transitively requires encryptionService, which needs a key at load time
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-totp-service-unit-tests-32ch';
}

// Dynamic import so the env assignment above runs first (static imports hoist).
const __totpService = (await import('../services/totpService.js')).default;

const {
  generateBackupCodes,
  normalizeBackupCode,
  verifyAndConsumeBackupCode,
} = __totpService;

describe('totpService backup codes', () => {
  it('generates the requested number of unique formatted codes', async () => {
    const { plain, hashed } = await generateBackupCodes(10);
    assert.equal(plain.length, 10);
    assert.equal(hashed.length, 10);
    assert.equal(new Set(plain).size, 10);
    for (const code of plain) {
      assert.match(code, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
    }
    for (const hash of hashed) {
      assert.ok(hash.startsWith('$2'), 'codes must be stored bcrypt-hashed');
    }
  });

  it('normalizes case, spaces and dashes', () => {
    assert.equal(normalizeBackupCode(' ab1c2-3d4e5 '), 'AB1C23D4E5');
    assert.equal(normalizeBackupCode('AB1C23D4E5'), 'AB1C23D4E5');
  });

  it('verifies a valid code and consumes it', async () => {
    const { plain, hashed } = await generateBackupCodes(3);
    const result = await verifyAndConsumeBackupCode(plain[1], hashed);
    assert.equal(result.ok, true);
    assert.equal(result.remaining.length, 2);

    // The consumed code no longer verifies
    const again = await verifyAndConsumeBackupCode(plain[1], result.remaining);
    assert.equal(again.ok, false);
    assert.equal(again.remaining.length, 2);
  });

  it('accepts codes regardless of case/dashes', async () => {
    const { plain, hashed } = await generateBackupCodes(1);
    const sloppy = plain[0].toLowerCase().replace('-', ' ');
    const result = await verifyAndConsumeBackupCode(sloppy, hashed);
    assert.equal(result.ok, true);
  });

  it('rejects invalid and too-short input without consuming', async () => {
    const { hashed } = await generateBackupCodes(2);
    const bad = await verifyAndConsumeBackupCode('NOPE-NOPE', hashed);
    assert.equal(bad.ok, false);
    assert.equal(bad.remaining.length, 2);
    const short = await verifyAndConsumeBackupCode('AB', hashed);
    assert.equal(short.ok, false);
  });
});
