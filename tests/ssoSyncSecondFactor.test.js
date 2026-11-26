import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.ENCRYPTION_KEY ||= 'test-key-for-sso-second-factor-tests-only';
const { syncSecondFactor } = await import('../mongoose/controllers/ssoController.js');

describe('hcs-sync token: second factor', () => {
  it('asks for the TOTP code when an authenticator app is set up', () => {
    assert.equal(syncSecondFactor({ totpEnabled: true, totpSecret: 's', passkeys: [] }), 'totp');
  });

  it('prefers TOTP when there are passkeys too (the form can check a code)', () => {
    assert.equal(syncSecondFactor({ totpEnabled: true, totpSecret: 's', passkeys: [{}] }), 'totp');
  });

  it('refuses the form for passkey-only accounts', () => {
    assert.equal(syncSecondFactor({ totpEnabled: false, passkeys: [{ credentialId: 'x' }] }), 'passkey');
  });

  it('needs nothing more when no second factor is set up', () => {
    assert.equal(syncSecondFactor({ totpEnabled: false, passkeys: [] }), null);
    assert.equal(syncSecondFactor({ totpEnabled: true, totpSecret: null }), null);
  });
});
