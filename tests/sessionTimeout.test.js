import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import router, { sessionExpiresAt, exposeSessionExpiry } from '../mongoose/routes/sessionTimeoutRoutes.js';

/** Session time limit warning (WCAG 2.2.1): the page knows when the session ends and can extend it. */

const extendHandler = router.stack.find((l) => l.route?.path === '/session/extend').route.stack[0].handle;

describe('session expiry', () => {
  it('reads the expiry from the session cookie', () => {
    const at = Date.now() + 3600_000;
    assert.equal(sessionExpiresAt({ session: { cookie: { expires: new Date(at) } } }), at);
    assert.equal(sessionExpiresAt({ session: {} }), null);
  });

  it('exposes it to templates only for a signed-in user', () => {
    const at = new Date(Date.now() + 1000);
    const res = { locals: {} };
    exposeSessionExpiry({ user: { _id: 1 }, session: { cookie: { expires: at } } }, res, () => {});
    assert.equal(res.locals.sessionExpiresAt, at.getTime());
    const anon = { locals: {} };
    exposeSessionExpiry({ session: { cookie: { expires: at } } }, anon, () => {});
    assert.equal(anon.locals.sessionExpiresAt, null);
  });

  it('extending marks the session changed and returns the new expiry', async () => {
    const later = new Date(Date.now() + 8 * 3600_000);
    const session = {
      cookie: { expires: new Date(Date.now() + 60_000), originalMaxAge: 8 * 3600_000 },
      save(cb) { this.cookie.expires = later; cb(); },
    };
    const body = await new Promise((resolve) => {
      extendHandler({ user: { _id: 1 }, session }, { status() { return this; }, json: resolve });
    });
    assert.equal(body.ok, true);
    assert.equal(body.expiresAt, later.getTime());
    assert.ok(session.extendedAt);
  });

  it('refuses without a signed-in user', async () => {
    const res = await new Promise((resolve) => {
      const r = { code: 200, status(c) { this.code = c; return this; }, json() { resolve(this); } };
      extendHandler({ session: {} }, r);
    });
    assert.equal(res.code, 401);
  });

  it('the layout loads the warning script and writes the expiry meta tag', () => {
    const layout = fs.readFileSync(path.resolve('mongoose/views/tailwindcss/layout.ejs'), 'utf8');
    assert.match(layout, /name="session-expires-at"/);
    assert.match(layout, /session-timeout\.js/);
  });
});
