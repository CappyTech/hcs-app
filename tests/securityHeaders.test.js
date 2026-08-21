import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import securityService, { trustEdgeTls, PERMISSIONS_POLICY, securityHeaders, xssSanitize } from '../services/securityService.js';

/**
 * A securityheaders.com scan of https://app.heroncs.co.uk (2026-08-20) found the
 * Permissions-Policy header missing and both cookies going out without `Secure`.
 *
 * These drive a real express app over a real socket, because both findings are
 * about what actually reaches the wire: a header set on the wrong router, or a
 * scheme override placed after the session middleware, would still look right
 * in the source.
 */
describe('security headers', () => {
  let server;
  let origin;

  before(async () => {
    const app = express();
    app.set('trust proxy', ['loopback', '172.16.0.0/12']);
    app.use(trustEdgeTls);
    app.use(securityService);
    app.get('/probe', (req, res) => res.json({ secure: req.secure }));
    // Stands in for requestBlocklistService, /favicon.ico, /healthz and the
    // maintenance 503 — everything that answers before appRouter is reached.
    app.use((_req, res) => res.status(403).type('text/plain').send('Forbidden'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    delete process.env.TRUST_EDGE_TLS;
  });

  it('sends a Permissions-Policy header', async () => {
    const res = await fetch(`${origin}/probe`);
    assert.equal(res.headers.get('permissions-policy'), PERMISSIONS_POLICY);
  });

  it('denies the powerful features this app never uses', async () => {
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'display-capture']) {
      assert.match(PERMISSIONS_POLICY, new RegExp(`(^|, )${feature}=\\(\\)`), `${feature} should be denied`);
    }
  });

  it('leaves clipboard-write alone and keeps fullscreen for self', () => {
    // The admin log viewer copies with navigator.clipboard; denying it would
    // break a working control to satisfy a scanner.
    assert.ok(!/clipboard-write/.test(PERMISSIONS_POLICY), 'clipboard-write must stay at its default');
    assert.match(PERMISSIONS_POLICY, /fullscreen=\(self\)/);
  });

  describe('trustEdgeTls', () => {
    it('leaves the scheme alone when unset', async () => {
      const res = await fetch(`${origin}/probe`, { headers: { 'x-forwarded-proto': 'http' } });
      assert.equal((await res.json()).secure, false);
    });

    it('marks the request secure when the edge terminates TLS', async () => {
      // frps forwards over plain HTTP and stamps X-Forwarded-Proto: http, so the
      // override has to beat a header that is present and wrong — not merely
      // supply a missing one.
      process.env.TRUST_EDGE_TLS = 'true';
      const res = await fetch(`${origin}/probe`, { headers: { 'x-forwarded-proto': 'http' } });
      assert.equal((await res.json()).secure, true);
    });

    it('is off unless the value is exactly true', async () => {
      process.env.TRUST_EDGE_TLS = 'yes';
      const res = await fetch(`${origin}/probe`);
      assert.equal((await res.json()).secure, false);
    });
  });
});

/**
 * The headers have to be mounted above everything that can answer a request.
 * Mounted on appRouter, as they were, a blocked scanner got bare 403s carrying
 * no CSP, no X-Frame-Options and no X-Content-Type-Options — and reported the
 * site as having none of them, off the back of 92% of its requests being 403s.
 */
describe('headers on responses that never reach the router', () => {
  let server;
  let origin;

  before(async () => {
    const app = express();
    app.use(securityHeaders);
    app.use((_req, res) => res.status(403).type('text/plain').send('Forbidden'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('sets them on a 403 from before the router', async () => {
    const res = await fetch(`${origin}/anything`);
    assert.equal(res.status, 403);
    for (const header of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'permissions-policy']) {
      assert.ok(res.headers.get(header), `${header} missing on a pre-router 403`);
    }
  });

  it('keeps the body sanitiser separate from the headers', () => {
    // It rewrites req.body, so it has to stay after the body parsers on
    // appRouter — while headers only get less useful the later they mount.
    assert.ok(!securityHeaders.includes(xssSanitize), 'xssSanitize must not be mounted with the headers');
    assert.equal(securityService[securityService.length - 1], xssSanitize);
  });
});
