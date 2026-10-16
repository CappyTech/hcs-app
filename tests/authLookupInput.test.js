import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { plainString } from '../services/plainStringInput.js';

// userCRUDController loads encryptionService, which needs a key at import time
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
}

/**
 * Express parses `token[$ne]=` and `usernameOrEmail[$gt]=` into objects.
 * Before this, those objects went straight into the findOne filter for the
 * reset-password, verify-email, login and forgot-password lookups, so a
 * caller could match "any pending reset" or "any account" without knowing
 * the value. Every such lookup now coerces the field to a plain string and
 * refuses the empty string before touching the database.
 */

describe('plainString', () => {
  it('returns a trimmed string unchanged', () => {
    assert.equal(plainString('  abc  '), 'abc');
  });

  for (const [label, value] of [
    ['an operator object', { $ne: '' }],
    ['an array', ['a']],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
  ]) {
    it(`returns the empty string for ${label}`, () => {
      assert.equal(plainString(value), '');
    });
  }
});

// ── the handlers themselves ─────────────────────────────────────────────────

const calls = [];
mock.module('../mongoose/services/mongooseDatabaseService.js', {
  defaultExport: {
    INTERNAL: {
      user: {
        findOne: async (filter, projection, options) => {
          calls.push({ filter, options });
          return null;
        },
      },
    },
  },
});
mock.module('../services/loggerService.js', {
  defaultExport: { info() {}, warn() {}, error() {}, debug() {} },
});

const ctrl = await import('../mongoose/controllers/userCRUDController.js');

const makeRes = () => {
  const res = { redirected: null, rendered: null };
  res.redirect = (url) => { res.redirected = url; };
  res.render = (view, locals) => { res.rendered = { view, locals }; };
  res.status = () => res;
  return res;
};
const makeReq = ({ body = {}, query = {} } = {}) => ({
  body,
  query,
  headers: {},
  session: {},
  flash() {},
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
});

const INJECTED = { $ne: '' };

describe('auth lookups refuse non-string input', () => {
  beforeEach(() => { calls.length = 0; });

  it('verifyEmail does not query with an object token', async () => {
    const res = makeRes();
    await ctrl.verifyEmail(makeReq({ query: { token: INJECTED } }), res);
    assert.equal(calls.length, 0);
    assert.equal(res.redirected, '/user/login');
  });

  it('renderResetPasswordForm does not query with an object token', async () => {
    const res = makeRes();
    await ctrl.renderResetPasswordForm(makeReq({ query: { token: INJECTED } }), res);
    assert.equal(calls.length, 0);
    assert.equal(res.redirected, '/user/login');
  });

  it('resetPassword does not query with an object token', async () => {
    const res = makeRes();
    await ctrl.resetPassword(
      makeReq({ body: { token: INJECTED, password: 'longenough', confirmPassword: 'longenough' } }),
      res,
    );
    assert.equal(calls.length, 0);
    assert.equal(res.redirected, '/user/login');
  });

  it('sendPasswordReset does not query with an object identifier', async () => {
    const res = makeRes();
    await ctrl.sendPasswordReset(makeReq({ body: { usernameOrEmail: INJECTED } }), res);
    assert.equal(calls.length, 0);
    assert.equal(res.redirected, '/user/forgot-password');
  });

  it('loginUser does not query with an object identifier', async () => {
    const prev = process.env.SKIP_TURNSTILE;
    process.env.SKIP_TURNSTILE = 'true';
    try {
      const res = makeRes();
      await ctrl.loginUser(makeReq({ body: { usernameOrEmail: INJECTED, password: 'x' } }), res);
      assert.equal(calls.length, 0);
      assert.equal(res.redirected, '/user/login');
    } finally {
      if (prev === undefined) delete process.env.SKIP_TURNSTILE; else process.env.SKIP_TURNSTILE = prev;
    }
  });

  it('a string token is looked up with sanitizeFilter on', async () => {
    const res = makeRes();
    await ctrl.renderResetPasswordForm(makeReq({ query: { token: ' abc123 ' } }), res);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].filter.passwordResetToken, 'abc123');
    assert.equal(calls[0].options?.sanitizeFilter, true);
  });

  it('a string identifier is looked up with sanitizeFilter on', async () => {
    const res = makeRes();
    await ctrl.sendPasswordReset(makeReq({ body: { usernameOrEmail: 'Someone@Example.test' } }), res);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filter.$or, [
      { username: 'Someone@Example.test' },
      { email: 'someone@example.test' },
    ]);
    assert.equal(calls[0].options?.sanitizeFilter, true);
  });
});
