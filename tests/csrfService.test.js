const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../services/loggerService');

/*
 * csrfService only requires logger at top level — real logger is fine.
 * We test the middleware's token generation and validation logic.
 */
const csrfService = require('../services/csrfService');

/* ── helpers ──────────────────────────────────────────────────────── */
function makeReq(overrides = {}) {
  return {
    method: 'GET',
    path: '/',
    originalUrl: '/',
    secure: false,
    session: { csrfToken: null, save: mock.fn((cb) => cb && cb()) },
    cookies: {},
    body: {},
    headers: {},
    query: {},
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _cookies: {},
    locals: {},
    cookie: mock.fn((name, value, opts) => { res._cookies[name] = { value, opts }; }),
    status: mock.fn((code) => { res._status = code; return res; }),
    send: mock.fn((body) => { res._body = body; }),
  };
  return res;
}

/* ── tests ─────────────────────────────────────────────────────────── */
describe('csrfService', () => {
  beforeEach(() => {
    delete process.env.STRICT_MODE;
  });

  describe('token generation', () => {
    it('generates token on first request', (_, done) => {
      const req = makeReq();
      const res = makeRes();
      csrfService(req, res, () => {
        assert.ok(req.session.csrfToken);
        assert.equal(req.session.csrfToken.length, 48); // 24 bytes hex
        assert.equal(res.locals.csrfToken, req.session.csrfToken);
        done();
      });
    });

    it('reuses existing session token', (_, done) => {
      const req = makeReq({ session: { csrfToken: 'existing123', save: mock.fn() } });
      const res = makeRes();
      csrfService(req, res, () => {
        assert.equal(req.session.csrfToken, 'existing123');
        done();
      });
    });

    it('uses the session token for res.locals even when a cookie is present', (_, done) => {
      const req = makeReq({
        session: { csrfToken: 'sessionTok', save: mock.fn() },
        cookies: { 'hms.csrf': 'cookieTok' },
      });
      const res = makeRes();
      csrfService(req, res, () => {
        assert.equal(res.locals.csrfToken, 'sessionTok');
        done();
      });
    });

    it('sets CSRF cookie', (_, done) => {
      const req = makeReq();
      const res = makeRes();
      csrfService(req, res, () => {
        assert.ok(res._cookies['hms.csrf']);
        assert.equal(res._cookies['hms.csrf'].opts.sameSite, 'lax');
        assert.equal(res._cookies['hms.csrf'].opts.httpOnly, false);
        done();
      });
    });
  });

  describe('safe methods bypass validation', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      it(`allows ${method} without token`, (_, done) => {
        csrfService(makeReq({ method }), makeRes(), () => done());
      });
    }
  });

  describe('non-safe methods require token', () => {
    it('allows POST when body._csrf matches session', (_, done) => {
      const token = 'valid_token_48chars_padded_to_reach_48_charszz';
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: token, save: mock.fn() }, body: { _csrf: token } }),
        makeRes(),
        () => done()
      );
    });

    it('allows POST when body.csrfToken matches', (_, done) => {
      const token = 'tok';
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: token, save: mock.fn() }, body: { csrfToken: token } }),
        makeRes(),
        () => done()
      );
    });

    it('allows POST when X-CSRF-Token header matches', (_, done) => {
      const token = 'tok';
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: token, save: mock.fn() }, headers: { 'x-csrf-token': token } }),
        makeRes(),
        () => done()
      );
    });

    it('allows POST when X-XSRF-Token header matches', (_, done) => {
      const token = 'tok';
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: token, save: mock.fn() }, headers: { 'x-xsrf-token': token } }),
        makeRes(),
        () => done()
      );
    });

    it('rejects POST when token is only in the query string (strict)', () => {
      process.env.STRICT_MODE = 'true';
      const token = 'tok';
      const res = makeRes();
      let nextCalled = false;
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: token, save: mock.fn() }, query: { _csrf: token } }),
        res,
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });

    it('rejects POST when token only matches the cookie, not the session (strict)', () => {
      process.env.STRICT_MODE = 'true';
      const token = 'cookieTok';
      const res = makeRes();
      let nextCalled = false;
      csrfService(
        makeReq({
          method: 'POST',
          session: { csrfToken: 'differentSession', save: mock.fn() },
          cookies: { 'hms.csrf': token },
          body: { _csrf: token },
        }),
        res,
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });
  });

  describe('strict mode is the default', () => {
    it('blocks POST with missing token when STRICT_MODE is unset', () => {
      const res = makeRes();
      let nextCalled = false;
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: 'real', save: mock.fn() } }),
        res,
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });
  });

  describe('transitional mode (STRICT_MODE=false)', () => {
    it('allows POST with missing token and logs warning', (_, done) => {
      process.env.STRICT_MODE = 'false';
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: 'real', save: mock.fn() } }),
        makeRes(),
        () => done()
      );
    });
  });

  describe('strict mode', () => {
    it('blocks POST with missing token (403)', () => {
      process.env.STRICT_MODE = 'true';
      const res = makeRes();
      let nextCalled = false;
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: 'real', save: mock.fn() } }),
        res,
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });

    it('blocks POST with wrong token', () => {
      process.env.STRICT_MODE = 'true';
      const res = makeRes();
      let nextCalled = false;
      csrfService(
        makeReq({ method: 'POST', session: { csrfToken: 'real', save: mock.fn() }, body: { _csrf: 'wrong' } }),
        res,
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });
  });

  describe('exempt paths', () => {
    it('allows the built-in exempt path without a token', (_, done) => {
      process.env.STRICT_MODE = 'true';
      csrfService(
        makeReq({ method: 'POST', path: '/api/sso/token', originalUrl: '/api/sso/token', session: { csrfToken: 'real', save: mock.fn() } }),
        makeRes(),
        () => done()
      );
    });

    it('does not exempt sibling paths sharing the prefix', () => {
      process.env.STRICT_MODE = 'true';
      const res = makeRes();
      let nextCalled = false;
      csrfService(
        makeReq({ method: 'POST', path: '/api/sso/tokenx', originalUrl: '/api/sso/tokenx', session: { csrfToken: 'real', save: mock.fn() } }),
        res,
        () => { nextCalled = true; }
      );
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });
  });

  describe('no session', () => {
    it('calls next() when session is missing', (_, done) => {
      csrfService(makeReq({ session: null }), makeRes(), () => done());
    });

    it('calls next() when session is undefined', (_, done) => {
      csrfService(makeReq({ session: undefined }), makeRes(), () => done());
    });
  });

  describe('error handling', () => {
    it('calls next() on internal error', (_, done) => {
      logger.info('(intentional error log follows — CSRF middleware error path)');
      const req = {
        method: 'POST',
        path: '/',
        originalUrl: '/',
        get session() { throw new Error('kaboom'); },
      };
      csrfService(req, makeRes(), () => done());
    });
  });
});
