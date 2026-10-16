import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import turnstile from '../services/turnstileService.js';

/**
 * The login/registration CAPTCHA is enforced only when both Turnstile keys
 * are configured. A fresh deployment has neither and must still be able to
 * log its first administrator in. SKIP_TURNSTILE=true is the explicit bypass.
 */
describe('turnstileService', () => {
  const saved = {};
  const KEYS = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'SKIP_TURNSTILE'];

  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('is not required and verifies without a token when no keys are set', async () => {
    assert.equal(turnstile.isConfigured(), false);
    assert.equal(turnstile.isRequired(), false);
    assert.deepEqual(await turnstile.verify(undefined, '127.0.0.1'), { ok: true, reason: 'not-configured' });
    assert.equal(turnstile.viewLocals().turnstileEnabled, false);
  });

  it('is not required with only one key set', () => {
    process.env.TURNSTILE_SITE_KEY = 'site';
    assert.equal(turnstile.isConfigured(), false);
    assert.equal(turnstile.isRequired(), false);
  });

  it('is required with both keys and rejects a missing token', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    assert.equal(turnstile.isRequired(), true);
    assert.deepEqual(await turnstile.verify('', '127.0.0.1'), { ok: false, reason: 'missing' });
    const locals = turnstile.viewLocals();
    assert.equal(locals.turnstileEnabled, true);
    assert.equal(locals.siteKey, 'site');
    assert.equal(locals.skipTurnstile, false);
  });

  it('SKIP_TURNSTILE=true bypasses even with keys set', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    process.env.SKIP_TURNSTILE = 'true';
    assert.equal(turnstile.isRequired(), false);
    assert.deepEqual(await turnstile.verify(undefined, '127.0.0.1'), { ok: true, reason: 'bypassed' });
    assert.equal(turnstile.viewLocals().skipTurnstile, true);
  });
});
