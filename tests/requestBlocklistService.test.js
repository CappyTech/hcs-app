import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * requestBlocklistService only requires loggerService at top level.
 * The real logger is fine — just test the middleware behaviour.
 */
import requestBlocklistService from '../services/requestBlocklistService.js';

/* ── helpers ──────────────────────────────────────────────────────── */
function makeReq(overrides = {}) {
  return {
    path: '/',
    url: '/',
    originalUrl: '/',
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    setHeader: mock.fn((k, v) => { res._headers[k] = v; }),
    status: mock.fn((code) => { res._status = code; return res; }),
    type: mock.fn(() => res),
    send: mock.fn((body) => { res._body = body; }),
    end: mock.fn(),
  };
  return res;
}

function isBlocked(req) {
  const res = makeRes();
  let nextCalled = false;
  requestBlocklistService(req, res, () => { nextCalled = true; });
  return !nextCalled;
}

/* ── tests ─────────────────────────────────────────────────────────── */
describe('requestBlocklistService', () => {
  describe('allows clean requests', () => {
    it('passes normal paths through', (_, done) => {
      requestBlocklistService(makeReq({ path: '/dashboard' }), makeRes(), () => done());
    });

    it('always allows /healthz', (_, done) => {
      requestBlocklistService(makeReq({ path: '/healthz' }), makeRes(), () => done());
    });
  });

  describe('blocks PHP/WordPress probes', () => {
    for (const path of ['/admin.php', '/wp-admin/index.php', '/wp-login.php', '/xmlrpc.php']) {
      it(`blocks ${path}`, () => {
        assert.ok(isBlocked(makeReq({ path, url: path })));
      });
    }
  });

  describe('blocks sensitive paths', () => {
    for (const path of ['/.env', '/.git/', '/.htaccess', '/phpmyadmin']) {
      it(`blocks ${path}`, () => {
        assert.ok(isBlocked(makeReq({ path, url: path })));
      });
    }
  });

  describe('blocks backup/dump patterns', () => {
    for (const path of ['/dump.sql', '/backup.zip', '/backup']) {
      it(`blocks ${path}`, () => {
        assert.ok(isBlocked(makeReq({ path, url: path })));
      });
    }
  });

  describe('heuristics — directory traversal', () => {
    it('blocks .. traversal', () => {
      assert.ok(isBlocked(makeReq({ path: '/', url: '/../../etc/passwd', originalUrl: '/../../etc/passwd' })));
    });

    it('blocks encoded traversal (%2e%2e)', () => {
      assert.ok(isBlocked(makeReq({ path: '/', url: '/%2e%2e/etc/passwd', originalUrl: '/%2e%2e/etc/passwd' })));
    });
  });

  describe('heuristics — SQLi/XSS fragments', () => {
    it('blocks union select', () => {
      assert.ok(isBlocked(makeReq({ path: '/search', url: '/search?q=1+union select+1', originalUrl: '/search?q=1+union select+1' })));
    });

    it('blocks <script> in query', () => {
      assert.ok(isBlocked(makeReq({ path: '/page', url: '/page?name=<script>alert(1)</script>', originalUrl: '/page?name=<script>alert(1)</script>' })));
    });

    it('blocks javascript: in query', () => {
      assert.ok(isBlocked(makeReq({ path: '/page', url: '/page?redirect=javascript:alert(1)' })));
    });
  });

  describe('blocks executable extensions', () => {
    for (const ext of ['.asp', '.aspx', '.cgi', '.pl']) {
      it(`blocks *${ext}`, () => {
        const path = `/page${ext}`;
        assert.ok(isBlocked(makeReq({ path, url: path })));
      });
    }
  });

  describe('blocks specific probe filenames', () => {
    it('blocks /shell.php', () => {
      assert.ok(isBlocked(makeReq({ path: '/shell.php', url: '/shell.php' })));
    });

    it('blocks /vendor/phpunit', () => {
      assert.ok(isBlocked(makeReq({ path: '/vendor/phpunit/test.php', url: '/vendor/phpunit/test.php' })));
    });
  });

  describe('fails open on middleware errors', () => {
    it('calls next() if internal error occurs', (_, done) => {
      const req = { get path() { throw new Error('boom'); } };
      requestBlocklistService(req, makeRes(), () => done());
    });
  });
});
