import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cookiePrefix,
  sessionCookieName,
  csrfCookieName,
  allSessionCookieNames,
} from '../services/cookieNameService.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A scan flagged hms.csrf as script-readable and unprefixed.
 *
 * The prefix rules are enforced by the browser and failure is silent: a
 * `__Host-` cookie that arrives without Secure, without Path=/, or with a
 * Domain is dropped without a console message, which on the session cookie
 * means nobody can log in. So these pin *when* the prefix is claimed, not only
 * that it can be produced.
 */
describe('cookieNameService', () => {
  beforeEach(() => {
    delete process.env.COOKIE_SECURE;
    delete process.env.TRUST_EDGE_TLS;
    delete process.env.SESSION_COOKIE_DOMAIN;
  });

  it('claims no prefix when secure is decided per request', () => {
    // The default is cookie.secure 'auto' — secure depends on the request, so
    // it cannot be promised at the moment the cookie is named.
    assert.equal(cookiePrefix(), '');
    assert.equal(sessionCookieName(), 'hms.sid');
  });

  it('claims no prefix when secure cookies are explicitly off', () => {
    // Local HTTP development: a prefixed cookie would be rejected outright.
    process.env.COOKIE_SECURE = 'false';
    process.env.TRUST_EDGE_TLS = 'true';
    assert.equal(cookiePrefix(), '');
  });

  it('uses __Host- when every response is Secure and no domain is set', () => {
    process.env.TRUST_EDGE_TLS = 'true';
    assert.equal(sessionCookieName(), '__Host-hms.sid');
    assert.equal(csrfCookieName(), '__Host-hms.csrf');
  });

  it('falls back to __Secure- when a cookie domain is configured', () => {
    // __Host- forbids a Domain attribute; claiming it with one set would have
    // the browser drop the cookie and nobody could log in.
    process.env.COOKIE_SECURE = 'true';
    process.env.SESSION_COOKIE_DOMAIN = '.heroncs.co.uk';
    assert.equal(sessionCookieName(), '__Secure-hms.sid');
  });

  it('offers every historical name so logout can clear the old one', () => {
    process.env.TRUST_EDGE_TLS = 'true';
    const names = allSessionCookieNames();
    assert.ok(names.includes('__Host-hms.sid'));
    assert.ok(names.includes('hms.sid'), 'the pre-prefix name must still be cleared');
    assert.equal(new Set(names).size, names.length, 'no duplicates');
  });
});

describe('cookie flags', () => {
  const csrfSrc = fs.readFileSync(path.join(ROOT, 'services/csrfService.js'), 'utf8');

  it('sets the CSRF cookie httpOnly', () => {
    // Nothing reads it: every fetch in this app takes the token from the
    // server-rendered <meta name="csrf-token">. A readable copy bought nothing
    // and handed any XSS the token directly.
    const call = csrfSrc.match(/res\.cookie\(CSRF_COOKIE_NAME[\s\S]*?\}\);/);
    assert.ok(call, 'no CSRF cookie call found');
    assert.match(call[0], /httpOnly:\s*true/);
    assert.match(call[0], /path:\s*"\/"/, '__Host- requires Path=/');
  });

  it('never validates against the cookie', () => {
    // The cookie carries no authority — only the session token is compared —
    // which is what makes it safe to make it unreadable.
    assert.ok(!/req\.cookies\s*\[/.test(csrfSrc), 'CSRF must not be validated from a cookie');
  });

  it('has no hardcoded cookie name left anywhere', () => {
    // The name was hardcoded in five files including res.clearCookie at logout,
    // so a rename would have silently stopped logout clearing the cookie.
    const offenders = [];
    for (const file of ['services/csrfService.js', 'services/logRequestDetailsService.js',
      'mongoose/services/sessionService.js', 'mongoose/controllers/userCRUDController.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      if (/["']hms\.(sid|csrf)["']/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });
});
