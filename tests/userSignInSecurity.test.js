import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearFactors } from '../mongoose/controllers/userSignInSecurityController.js';

function user() {
  return {
    totpEnabled: true,
    totpSecret: 'enc',
    totpBackupCodes: ['a', 'b'],
    passkeys: [{ credentialId: 'x' }, { credentialId: 'y' }],
  };
}

describe('admin clear two-factor', () => {
  it('clears only the authenticator app when only that is ticked', () => {
    const u = user();
    assert.deepEqual(clearFactors(u, { totp: true, passkeys: false }), { totp: true, passkeys: 0 });
    assert.equal(u.totpEnabled, false);
    assert.equal(u.totpSecret, undefined);
    assert.deepEqual(u.totpBackupCodes, []);
    assert.equal(u.passkeys.length, 2);
  });

  it('clears only passkeys when only that is ticked', () => {
    const u = user();
    assert.deepEqual(clearFactors(u, { totp: false, passkeys: true }), { totp: false, passkeys: 2 });
    assert.deepEqual(u.passkeys, []);
    assert.equal(u.totpEnabled, true);
  });

  it('clears both', () => {
    const u = user();
    assert.deepEqual(clearFactors(u, { totp: true, passkeys: true }), { totp: true, passkeys: 2 });
  });

  it('reports nothing cleared when nothing was set up', () => {
    const u = { totpEnabled: false, totpBackupCodes: [], passkeys: [] };
    assert.deepEqual(clearFactors(u, { totp: true, passkeys: true }), { totp: false, passkeys: 0 });
  });
});
