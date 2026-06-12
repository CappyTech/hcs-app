const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

/*
 * authService requires mdb and rbac at top-level.
 * Patch mdb singleton; use real rbac (pure config).
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');

let userFindByIdResult = null;

function patchMdb() {
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    user: {
      findById: mock.fn(() => Promise.resolve(userFindByIdResult)),
    },
  };
}

const {
  ensureAuthenticated,
  ensureRoles,
  ensureRole,
  ensureAnyRole,
  ensureModelAccess,
  ensureOwnership,
  ensureRouteAccess,
  ensureDepartment,
} = require('../services/authService');

/* ── helpers ──────────────────────────────────────────────────────── */
function makeReq(overrides = {}) {
  return {
    originalUrl: '/dashboard',
    path: '/dashboard',
    session: { user: { id: 'user1' } },
    user: null,
    ...overrides,
  };
}

function makeRes() {
  const res = {
    _redirectUrl: null,
    _status: null,
    redirect: mock.fn((url) => { res._redirectUrl = url; }),
    status: mock.fn((code) => { res._status = code; return res; }),
    send: mock.fn(),
  };
  return res;
}

/* ── tests ─────────────────────────────────────────────────────────── */
describe('authService', () => {
  beforeEach(() => {
    userFindByIdResult = null;
    patchMdb();
  });

  describe('ensureAuthenticated', () => {
    it('allows public paths without session', async () => {
      const req = makeReq({ originalUrl: '/user/login', session: {} });
      let nextCalled = false;
      await ensureAuthenticated(req, makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('allows root path as public', async () => {
      const req = makeReq({ originalUrl: '/', session: {} });
      let nextCalled = false;
      await ensureAuthenticated(req, makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('loads user on public path if session exists', async () => {
      userFindByIdResult = { _id: 'user1', role: 'admin' };
      patchMdb();
      const req = makeReq({ originalUrl: '/user/login' });
      await ensureAuthenticated(req, makeRes(), () => {});
      assert.equal(req.user, userFindByIdResult);
    });

    it('redirects to login when no session on protected path', async () => {
      const req = makeReq({ originalUrl: '/dashboard', session: {} });
      const res = makeRes();
      await ensureAuthenticated(req, res, () => {});
      assert.ok(res._redirectUrl.startsWith('/user/login'));
      assert.ok(res._redirectUrl.includes('next='));
    });

    it('sets req.user when user found in DB', async () => {
      userFindByIdResult = { _id: 'user1', role: 'admin', emailVerified: true, totpEnabled: true };
      patchMdb();
      const req = makeReq();
      let nextCalled = false;
      await ensureAuthenticated(req, makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
      assert.equal(req.user.role, 'admin');
    });

    it('redirects privileged role without TOTP to account page', async () => {
      userFindByIdResult = { _id: 'user1', role: 'admin', emailVerified: true, totpEnabled: false };
      patchMdb();
      const res = makeRes();
      await ensureAuthenticated(makeReq({ originalUrl: '/dashboard' }), res, () => {});
      assert.equal(res._redirectUrl, '/user/account');
    });

    it('allows privileged role without TOTP to reach the account page', async () => {
      userFindByIdResult = { _id: 'user1', role: 'admin', emailVerified: true, totpEnabled: false };
      patchMdb();
      let nextCalled = false;
      await ensureAuthenticated(
        makeReq({ originalUrl: '/user/account' }),
        makeRes(),
        () => { nextCalled = true; }
      );
      assert.ok(nextCalled);
    });

    it('does not require TOTP for non-privileged roles', async () => {
      userFindByIdResult = { _id: 'user1', role: 'employee', emailVerified: true, totpEnabled: false };
      patchMdb();
      let nextCalled = false;
      await ensureAuthenticated(makeReq(), makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('REQUIRE_2FA_ROLES="" disables 2FA enforcement', async () => {
      process.env.REQUIRE_2FA_ROLES = '';
      try {
        userFindByIdResult = { _id: 'user1', role: 'admin', emailVerified: true, totpEnabled: false };
        patchMdb();
        let nextCalled = false;
        await ensureAuthenticated(makeReq(), makeRes(), () => { nextCalled = true; });
        assert.ok(nextCalled);
      } finally {
        delete process.env.REQUIRE_2FA_ROLES;
      }
    });

    it('redirects to login when user not found in DB', async () => {
      userFindByIdResult = null;
      patchMdb();
      const res = makeRes();
      await ensureAuthenticated(makeReq(), res, () => {});
      assert.equal(res._redirectUrl, '/user/login');
    });

    it('redirects unverified user to verify-pending', async () => {
      userFindByIdResult = { _id: 'u1', emailVerified: false, emailVerificationToken: 'tok' };
      patchMdb();
      const res = makeRes();
      await ensureAuthenticated(makeReq({ originalUrl: '/dashboard' }), res, () => {});
      assert.equal(res._redirectUrl, '/user/verify-pending');
    });

    it('allows unverified user to access verify-pending page', async () => {
      userFindByIdResult = { _id: 'u1', emailVerified: false, emailVerificationToken: 'tok' };
      patchMdb();
      let nextCalled = false;
      await ensureAuthenticated(
        makeReq({ originalUrl: '/user/verify-pending' }),
        makeRes(),
        () => { nextCalled = true; }
      );
      assert.ok(nextCalled);
    });

    it('treats legacy users (emailVerified undefined) as verified', async () => {
      userFindByIdResult = { _id: 'u1' };
      patchMdb();
      let nextCalled = false;
      await ensureAuthenticated(makeReq(), makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('allows resource paths without auth', async () => {
      const req = makeReq({ originalUrl: '/resources/css/style.css', session: {} });
      let nextCalled = false;
      await ensureAuthenticated(req, makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('calls next with error on DB failure', async () => {
      mdb.INTERNAL.user.findById = mock.fn(() => Promise.reject(new Error('DB down')));
      let nextErr = null;
      await ensureAuthenticated(makeReq(), makeRes(), (err) => { nextErr = err; });
      assert.ok(nextErr);
      assert.equal(nextErr.statusCode, 500);
    });
  });

  describe('ensureRoles', () => {
    it('allows matching role', (_, done) => {
      const mw = ensureRoles('admin', 'accountant');
      mw({ user: { role: 'admin', customPermissions: {} }, path: '/x' }, makeRes(), () => done());
    });

    it('rejects non-matching role with 403', () => {
      const mw = ensureRoles('admin');
      let nextErr = null;
      mw({ user: { role: 'employee', customPermissions: {} }, path: '/x' }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 403);
    });

    it('returns 401 when no user', () => {
      const mw = ensureRoles('admin');
      let nextErr = null;
      mw({ user: null, path: '/x' }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 401);
    });

    it('allows via custom route permission', () => {
      const mw = ensureRoles('admin');
      const req = {
        user: { role: 'employee', customPermissions: { routes: ['/admin'] } },
        path: '/admin',
      };
      let nextCalled = false;
      mw(req, makeRes(), () => { nextCalled = true; });
      assert.ok(nextCalled);
    });
  });

  describe('ensureRole', () => {
    it('public role is a passthrough', (_, done) => {
      ensureRole('public')({}, makeRes(), () => done());
    });

    it('defaults to admin', () => {
      const mw = ensureRole();
      let nextErr = null;
      mw({ user: { role: 'employee', customPermissions: {} }, path: '/x' }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 403);
    });
  });

  describe('ensureAnyRole', () => {
    it('allows any authenticated user', (_, done) => {
      ensureAnyRole()({ user: { role: 'employee' } }, makeRes(), () => done());
    });

    it('returns 401 when no user', () => {
      let nextErr = null;
      ensureAnyRole()({ user: null }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 401);
    });
  });

  describe('ensureModelAccess', () => {
    it('allows admin for any model', (_, done) => {
      const mw = ensureModelAccess('invoice', 'r');
      const req = { user: { role: 'admin', customPermissions: {} } };
      mw(req, makeRes(), () => {
        assert.deepStrictEqual(req.rbac, { ownOnly: false, model: 'invoice', operation: 'r' });
        done();
      });
    });

    it('returns 403 for role none', () => {
      let nextErr = null;
      ensureModelAccess('invoice', 'r')(
        { user: { role: 'none', customPermissions: {} } },
        makeRes(),
        (err) => { nextErr = err; }
      );
      assert.equal(nextErr.statusCode, 403);
    });

    it('returns 401 when no user', () => {
      let nextErr = null;
      ensureModelAccess('invoice', 'r')({ user: null }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 401);
    });
  });

  describe('ensureOwnership', () => {
    it('admin gets empty filter', (_, done) => {
      const req = { user: { role: 'admin' } };
      ensureOwnership('attendance')(req, makeRes(), () => {
        assert.deepStrictEqual(req.ownershipFilter, {});
        done();
      });
    });

    it('non-ownOnly gets empty filter', (_, done) => {
      const req = { user: { role: 'accountant' }, rbac: { ownOnly: false } };
      ensureOwnership('invoice')(req, makeRes(), () => {
        assert.deepStrictEqual(req.ownershipFilter, {});
        done();
      });
    });

    it('ownOnly builds filter from ownership config', (_, done) => {
      const req = { user: { role: 'employee', employeeId: 'emp1' }, rbac: { ownOnly: true } };
      ensureOwnership('attendance')(req, makeRes(), () => {
        assert.deepStrictEqual(req.ownershipFilter, { employeeId: 'emp1' });
        done();
      });
    });

    it('returns 403 when user lacks linked field', () => {
      let nextErr = null;
      ensureOwnership('attendance')(
        { user: { role: 'employee' }, rbac: { ownOnly: true } },
        makeRes(),
        (err) => { nextErr = err; }
      );
      assert.equal(nextErr.statusCode, 403);
    });

    it('returns 401 when no user', () => {
      let nextErr = null;
      ensureOwnership('attendance')({ user: null }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 401);
    });
  });

  describe('ensureRouteAccess', () => {
    it('allows when no pattern matches', (_, done) => {
      ensureRouteAccess(
        { user: { role: 'employee', customPermissions: {} }, path: '/some-unknown-path' },
        makeRes(),
        () => done()
      );
    });

    it('returns 403 for disallowed route', () => {
      let nextErr = null;
      ensureRouteAccess(
        { user: { role: 'employee', customPermissions: {} }, path: '/admin' },
        makeRes(),
        (err) => { nextErr = err; }
      );
      assert.equal(nextErr.statusCode, 403);
    });

    it('passes through when no user', (_, done) => {
      ensureRouteAccess({ user: null, path: '/admin' }, makeRes(), () => done());
    });
  });

  describe('ensureDepartment', () => {
    it('allows admin for any department', (_, done) => {
      ensureDepartment('finance')(
        { user: { role: 'admin', customPermissions: {} } },
        makeRes(),
        () => done()
      );
    });

    it('returns 403 for employee accessing admin department', () => {
      let nextErr = null;
      ensureDepartment('admin')(
        { user: { role: 'employee', customPermissions: {} } },
        makeRes(),
        (err) => { nextErr = err; }
      );
      assert.equal(nextErr.statusCode, 403);
    });

    it('returns 401 when no user', () => {
      let nextErr = null;
      ensureDepartment('admin')({ user: null }, makeRes(), (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 401);
    });
  });
});
