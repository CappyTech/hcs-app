import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import securityMiddleware from '../services/securityService.js';

// securityService exports an array: [helmet, xssSanitize]
const xssSanitize = securityMiddleware[securityMiddleware.length - 1];

function mockReq(overrides = {}) {
  return { body: {}, query: {}, params: {}, ...overrides };
}

function run(req) {
  let called = false;
  xssSanitize(req, {}, () => { called = true; });
  assert.ok(called, 'next() must be called');
  return req;
}

describe('xssSanitize middleware', () => {
  it('strips script tags from body strings', () => {
    const req = run(mockReq({ body: { name: '<script>alert(1)</script>Hello' } }));
    assert.ok(!req.body.name.includes('<script>'), 'script tag should be removed');
    assert.ok(req.body.name.includes('Hello'), 'safe content preserved');
  });

  it('strips script tags from query strings', () => {
    const req = run(mockReq({ query: { q: '<script>xss</script>search' } }));
    assert.ok(!req.query.q.includes('<script>'));
    assert.ok(req.query.q.includes('search'));
  });

  it('strips script tags from params', () => {
    const req = run(mockReq({ params: { id: '<img onerror=alert(1) src=x>' } }));
    assert.ok(!req.params.id.includes('onerror'));
  });

  it('handles nested objects', () => {
    const req = run(mockReq({ body: { user: { bio: '<script>evil</script>safe' } } }));
    assert.ok(!req.body.user.bio.includes('<script>'));
    assert.ok(req.body.user.bio.includes('safe'));
  });

  it('preserves non-string values', () => {
    const req = run(mockReq({ body: { count: 42, active: true, tags: null } }));
    assert.equal(req.body.count, 42);
    assert.equal(req.body.active, true);
    assert.equal(req.body.tags, null);
  });

  it('handles missing body/query/params gracefully', () => {
    const req = run({ body: undefined, query: undefined, params: undefined });
    assert.equal(req.body, undefined);
  });

  it('strips event handlers from HTML attributes', () => {
    const req = run(mockReq({ body: { html: '<div onmouseover="steal()">text</div>' } }));
    assert.ok(!req.body.html.includes('onmouseover'));
    assert.ok(req.body.html.includes('text'));
  });

  it('leaves clean strings untouched', () => {
    const req = run(mockReq({ body: { name: 'John Doe' }, query: { page: '2' } }));
    assert.equal(req.body.name, 'John Doe');
    assert.equal(req.query.page, '2');
  });
});
