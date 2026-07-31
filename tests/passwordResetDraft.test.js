import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import passwordResetDraft, { TTL_MS } from '../services/passwordResetDraft.js';

const { stash, take, clear, dropOnLeave } = passwordResetDraft;

/** Minimal express-ish request. `headers` keys must be lowercase. */
const makeReq = ({ session = {}, method = 'GET', path = '/', headers = {} } = {}) => ({
  session,
  method,
  path,
  get: (name) => headers[String(name).toLowerCase()],
});

const pendingSession = (pending = { userId: 'u1' }) => ({ passwordResetPending: pending });

const navigate = (path, session) =>
  makeReq({ session, path, headers: { 'sec-fetch-dest': 'document' } });

const run = (req) => {
  let called = false;
  dropOnLeave(req, {}, () => { called = true; });
  assert.ok(called, 'dropOnLeave must always call next()');
};

describe('passwordResetDraft', () => {
  describe('stash / take', () => {
    it('carries the passwords across one redirect', () => {
      const req = makeReq({ session: pendingSession() });
      stash(req, { password: 'correct horse', confirmPassword: 'correct horse' });

      assert.deepEqual(take(req), {
        password: 'correct horse',
        confirmPassword: 'correct horse',
      });
    });

    it('is single use — a second read comes back empty', () => {
      const req = makeReq({ session: pendingSession() });
      stash(req, { password: 'pw', confirmPassword: 'pw' });

      take(req);
      // Revisiting the page after the retry has been repopulated must start blank.
      assert.deepEqual(take(req), { password: '', confirmPassword: '' });
      assert.equal(req.session.passwordResetPending.draft, undefined);
    });

    it('returns empty strings rather than undefined when there is nothing stashed', () => {
      // Views interpolate this unconditionally.
      assert.deepEqual(take(makeReq({ session: pendingSession() })), {
        password: '',
        confirmPassword: '',
      });
      assert.deepEqual(take(makeReq()), { password: '', confirmPassword: '' });
    });

    it('does nothing when no reset is in progress', () => {
      const req = makeReq({ session: {} });
      stash(req, { password: 'pw', confirmPassword: 'pw' });
      assert.equal(req.session.passwordResetPending, undefined);
    });

    it('ignores an empty password', () => {
      const req = makeReq({ session: pendingSession() });
      stash(req, { password: '', confirmPassword: '' });
      assert.equal(req.session.passwordResetPending.draft, undefined);
    });

    it('lives inside passwordResetPending, so ending the flow takes it with it', () => {
      // This is why there is no separate teardown to forget: success, "start
      // over" and session expiry all delete passwordResetPending already.
      const session = pendingSession();
      const req = makeReq({ session });
      stash(req, { password: 'pw', confirmPassword: 'pw' });
      assert.ok(session.passwordResetPending.draft);

      delete session.passwordResetPending;
      assert.deepEqual(take(req), { password: '', confirmPassword: '' });
    });

    it('expires an abandoned draft', () => {
      const session = pendingSession();
      const req = makeReq({ session });
      stash(req, { password: 'pw', confirmPassword: 'pw' });
      session.passwordResetPending.draft.at = Date.now() - TTL_MS - 1;

      assert.deepEqual(take(req), { password: '', confirmPassword: '' });
    });

    it('clear() discards without reading', () => {
      const req = makeReq({ session: pendingSession() });
      stash(req, { password: 'pw', confirmPassword: 'pw' });
      clear(req);
      assert.equal(req.session.passwordResetPending.draft, undefined);
    });
  });

  describe('dropOnLeave', () => {
    const withDraft = () => {
      const session = pendingSession();
      const req = makeReq({ session });
      stash(req, { password: 'pw', confirmPassword: 'pw' });
      return session;
    };

    for (const p of [
      '/user/verify-totp-reset',
      '/user/verify-sms-otp',
      '/user/forgot-password',
      '/user/forgot-password/choose',
      '/user/reset-password',
      '/user/verify-sms-otp/', // trailing slash is the same page
    ]) {
      it(`keeps the draft while inside the reset flow (${p})`, () => {
        const session = withDraft();
        run(navigate(p, session));
        assert.ok(session.passwordResetPending.draft, `${p} must not clear the draft`);
      });
    }

    for (const p of ['/', '/dashboard', '/user/login', '/cis']) {
      it(`drops the draft on navigating to ${p}`, () => {
        const session = withDraft();
        run(navigate(p, session));
        assert.equal(session.passwordResetPending.draft, undefined);
        assert.ok(session.passwordResetPending, 'only the draft goes, not the flow');
      });
    }

    it('ignores sub-resource requests from the reset page itself', () => {
      // The page's own CSS, service worker and favicon must not read as leaving.
      for (const dest of ['style', 'script', 'image', 'serviceworker', 'font']) {
        const session = withDraft();
        run(makeReq({
          session,
          path: '/resources/css/app.css',
          headers: { 'sec-fetch-dest': dest },
        }));
        assert.ok(session.passwordResetPending.draft, `${dest} must not clear the draft`);
      }
    });

    it('ignores non-GET requests', () => {
      const session = withDraft();
      run(makeReq({ session, method: 'POST', path: '/somewhere' }));
      assert.ok(session.passwordResetPending.draft);
    });

    it('falls back to Accept when the browser sends no Sec-Fetch-Dest', () => {
      const html = pendingSession();
      const req = makeReq({ session: html });
      stash(req, { password: 'pw', confirmPassword: 'pw' });
      run(makeReq({ session: html, path: '/dashboard', headers: { accept: 'text/html' } }));
      assert.equal(html.passwordResetPending.draft, undefined);

      const asset = pendingSession();
      const req2 = makeReq({ session: asset });
      stash(req2, { password: 'pw', confirmPassword: 'pw' });
      run(makeReq({ session: asset, path: '/x.css', headers: { accept: 'text/css' } }));
      assert.ok(asset.passwordResetPending.draft);
    });

    it('is safe when there is no session or no draft', () => {
      run(makeReq({ path: '/dashboard' }));
      run(makeReq({ session: pendingSession(), path: '/dashboard' }));
    });
  });
});
