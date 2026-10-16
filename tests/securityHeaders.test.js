import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import securityService, { trustEdgeTls, PERMISSIONS_POLICY, securityHeaders, xssSanitize, appOrigin, appWsOrigin } from '../services/securityService.js';

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

/**
 * hcs-app is deployed per company, so the policy's own-origin entries come from
 * the managed BASE_URL rather than a hostname in the source. They are read per
 * response, so a BASE_URL saved at /admin/config applies without a restart.
 */
describe('CSP own-origin entries derive from BASE_URL', () => {
  let server;
  let origin;
  const saved = process.env.BASE_URL;

  before(async () => {
    const app = express();
    app.use(securityHeaders);
    app.use((_req, res) => res.type('text/plain').send('ok'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    if (saved === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = saved;
    return new Promise((resolve) => server.close(resolve));
  });

  const csp = async () => (await fetch(`${origin}/`)).headers.get('content-security-policy');
  const directive = (policy, name) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '';

  it('names no company hostname in the source', () => {
    const src = fs.readFileSync(new URL('../services/securityService.js', import.meta.url), 'utf8');
    assert.ok(!/heroncs\.co\.uk/.test(src), 'securityService must not hard-code a deployment hostname');
  });

  it('uses the BASE_URL origin for default-src, connect-src, img-src and the WebSocket', async () => {
    process.env.BASE_URL = 'https://app.example.test/';
    const policy = await csp();
    assert.ok(directive(policy, 'default-src').includes('https://app.example.test'), policy);
    assert.ok(directive(policy, 'connect-src').includes('https://app.example.test'), policy);
    assert.ok(directive(policy, 'img-src').includes('https://app.example.test'), policy);
    if (process.env.NODE_ENV !== 'development') {
      assert.ok(directive(policy, 'connect-src').includes('wss://app.example.test'), policy);
    }
    assert.equal(appOrigin(), 'https://app.example.test');
    assert.equal(appWsOrigin(), 'wss://app.example.test');
  });

  it('follows a change to BASE_URL without a restart', async () => {
    process.env.BASE_URL = 'https://one.example.test';
    assert.ok((await csp()).includes('https://one.example.test'));
    process.env.BASE_URL = 'https://two.example.test';
    const policy = await csp();
    assert.ok(policy.includes('https://two.example.test'));
    assert.ok(!policy.includes('one.example.test'));
  });

  it("collapses to 'self' when BASE_URL is unset or not a URL, and still allows the third parties", async () => {
    delete process.env.BASE_URL;
    let policy = await csp();
    assert.ok(!/https:\/\/[a-z]+\.example\.test/.test(policy), policy);
    assert.ok(directive(policy, 'default-src').includes("'self'"));
    assert.ok(directive(policy, 'connect-src').includes('https://nominatim.openstreetmap.org'));
    assert.ok(directive(policy, 'img-src').includes('https://i.creativecommons.org'));
    assert.ok(directive(policy, 'script-src').includes('https://challenges.cloudflare.com'));
    assert.equal(appOrigin(), null);

    process.env.BASE_URL = 'not a url';
    assert.equal(appOrigin(), null);
    process.env.BASE_URL = 'ftp://files.example.test';
    assert.equal(appOrigin(), null);
    policy = await csp();
    assert.ok(!policy.includes('ftp://'), policy);
  });
});
