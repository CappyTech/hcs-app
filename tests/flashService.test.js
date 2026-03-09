const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const flashService = require('../services/flashService');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock req with optional __flash cookie value. */
function mockReq(flashCookie) {
  const cookies = {};
  if (flashCookie !== undefined) cookies.__flash = flashCookie;
  return { cookies };
}

/** Build a minimal mock res that tracks locals, cookies set/cleared, and end(). */
function mockRes() {
  const res = {
    locals: {},
    _cookies: {},
    _cleared: [],
    _ended: false,
    headersSent: false,
    cookie(name, value, opts) { res._cookies[name] = { value, opts }; },
    clearCookie(name) { res._cleared.push(name); },
    end() { res._ended = true; },
  };
  return res;
}

/** Run the flash middleware and return {req, res}. */
function run(flashCookie) {
  const req = mockReq(flashCookie);
  const res = mockRes();
  let called = false;
  flashService(req, res, () => { called = true; });
  assert.ok(called, 'next() must be called');
  return { req, res };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('flashService middleware', () => {

  describe('initialisation (no cookie)', () => {
    it('calls next()', () => {
      run(); // assertion inside run()
    });

    it('creates req.flash function', () => {
      const { req } = run();
      assert.equal(typeof req.flash, 'function');
    });

    it('sets res.locals.flash to empty object', () => {
      const { res } = run();
      assert.deepEqual(res.locals.flash, {});
    });

    it('sets successMessage and errorMessage to null', () => {
      const { res } = run();
      assert.equal(res.locals.successMessage, null);
      assert.equal(res.locals.errorMessage, null);
    });
  });

  describe('reading flash from cookie', () => {
    it('parses valid __flash cookie into res.locals.flash', () => {
      const cookie = JSON.stringify({ success: ['Saved!'] });
      const { res } = run(cookie);
      assert.deepEqual(res.locals.flash, { success: ['Saved!'] });
    });

    it('sets successMessage from cookie', () => {
      const cookie = JSON.stringify({ success: ['Done'] });
      const { res } = run(cookie);
      assert.deepEqual(res.locals.successMessage, ['Done']);
    });

    it('sets errorMessage from cookie', () => {
      const cookie = JSON.stringify({ error: ['Oops'] });
      const { res } = run(cookie);
      assert.deepEqual(res.locals.errorMessage, ['Oops']);
    });

    it('clears the __flash cookie after reading', () => {
      const cookie = JSON.stringify({ success: ['x'] });
      const { res } = run(cookie);
      assert.ok(res._cleared.includes('__flash'));
    });

    it('handles malformed JSON gracefully', () => {
      const { res } = run('not{json');
      assert.deepEqual(res.locals.flash, {});
      assert.equal(res.locals.successMessage, null);
    });

    it('handles empty string cookie', () => {
      const { res } = run('');
      assert.deepEqual(res.locals.flash, {});
    });
  });

  describe('req.flash() setter (same-request visibility)', () => {
    it('adds message to flash for current request', () => {
      const { req, res } = run();
      req.flash('success', 'Created');
      assert.deepEqual(res.locals.flash.success, ['Created']);
    });

    it('accumulates multiple messages of the same type', () => {
      const { req, res } = run();
      req.flash('error', 'A');
      req.flash('error', 'B');
      assert.deepEqual(res.locals.flash.error, ['A', 'B']);
    });

    it('supports multiple types simultaneously', () => {
      const { req, res } = run();
      req.flash('success', 'OK');
      req.flash('error', 'Fail');
      assert.deepEqual(res.locals.flash.success, ['OK']);
      assert.deepEqual(res.locals.flash.error, ['Fail']);
    });

    it('appends to existing cookie-sourced messages', () => {
      const cookie = JSON.stringify({ success: ['From cookie'] });
      const { req, res } = run(cookie);
      req.flash('success', 'From controller');
      assert.deepEqual(res.locals.flash.success, ['From cookie', 'From controller']);
    });
  });

  describe('req.flash() getter (consume pattern)', () => {
    it('returns messages and removes them from flash', () => {
      const cookie = JSON.stringify({ success: ['A', 'B'] });
      const { req, res } = run(cookie);
      const msgs = req.flash('success');
      assert.deepEqual(msgs, ['A', 'B']);
      assert.equal(res.locals.flash.success, undefined);
    });

    it('returns empty array for unset type', () => {
      const { req } = run();
      assert.deepEqual(req.flash('info'), []);
    });

    it('returns empty array on second get (messages consumed)', () => {
      const cookie = JSON.stringify({ error: ['Err'] });
      const { req } = run(cookie);
      req.flash('error'); // consume
      assert.deepEqual(req.flash('error'), []);
    });
  });

  describe('cookie injection on res.end()', () => {
    it('sets __flash cookie when messages were set', () => {
      const { req, res } = run();
      req.flash('success', 'Hello');
      res.end();
      assert.ok(res._cookies.__flash, 'cookie should be set');
      const parsed = JSON.parse(res._cookies.__flash.value);
      assert.deepEqual(parsed, { success: ['Hello'] });
    });

    it('sets cookie with maxAge 5000 and httpOnly false', () => {
      const { req, res } = run();
      req.flash('error', 'x');
      res.end();
      const opts = res._cookies.__flash.opts;
      assert.equal(opts.maxAge, 5000);
      assert.equal(opts.httpOnly, false);
    });

    it('does not set cookie when no messages were set', () => {
      const { res } = run();
      res.end();
      assert.equal(res._cookies.__flash, undefined);
    });

    it('does not set cookie when headers already sent', () => {
      const { req, res } = run();
      req.flash('success', 'Late');
      res.headersSent = true;
      res.end();
      assert.equal(res._cookies.__flash, undefined);
    });

    it('calls original res.end with arguments', () => {
      const { req, res } = run();
      let endArgs;
      // Replace the original end to capture args
      const origEnd = res.end;
      // Re-run middleware with a custom end spy
      const req2 = mockReq();
      const res2 = mockRes();
      res2.end = function (...args) { endArgs = args; };
      flashService(req2, res2, () => {});
      req2.flash('success', 'x');
      res2.end('body', 'utf8');
      assert.deepEqual(endArgs, ['body', 'utf8']);
    });
  });

  describe('redirect flow (full round-trip)', () => {
    it('messages set on request 1 appear on request 2', () => {
      // Request 1: controller sets flash, then redirect triggers end()
      const { req: req1, res: res1 } = run();
      req1.flash('success', 'Record saved');
      req1.flash('error', 'Warning: check dates');
      res1.end();

      // Simulate the browser sending the cookie back on request 2
      const cookieValue = res1._cookies.__flash.value;
      const { res: res2 } = run(cookieValue);

      assert.deepEqual(res2.locals.flash.success, ['Record saved']);
      assert.deepEqual(res2.locals.flash.error, ['Warning: check dates']);
      // Cookie should be cleared on request 2
      assert.ok(res2._cleared.includes('__flash'));
    });

    it('messages only appear once (cleared after read)', () => {
      const { req: req1, res: res1 } = run();
      req1.flash('success', 'Once');
      res1.end();

      // Request 2 reads it
      const cookieValue = res1._cookies.__flash.value;
      const { res: res2 } = run(cookieValue);
      assert.deepEqual(res2.locals.flash.success, ['Once']);

      // Request 3: no cookie from browser (it was cleared) → no flash
      const { res: res3 } = run();
      assert.deepEqual(res3.locals.flash, {});
    });
  });

  describe('same-request render flow', () => {
    it('flash set by controller is visible to view via flash object', () => {
      const { req, res } = run();
      req.flash('success', 'Created purchase');
      req.flash('error', 'But payment failed');

      // Simulate what views see
      const flash = res.locals.flash;
      assert.deepEqual(flash.success, ['Created purchase']);
      assert.deepEqual(flash.error, ['But payment failed']);
    });
  });
});
