const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIp, getClientIp } = require('../services/ipService');

// ── normalizeIp ──────────────────────────────────────────────────────────────

describe('normalizeIp', () => {
  describe('basic inputs', () => {
    it('returns empty string for null', () => {
      assert.equal(normalizeIp(null), '');
    });

    it('returns empty string for undefined', () => {
      assert.equal(normalizeIp(undefined), '');
    });

    it('returns empty string for empty string', () => {
      assert.equal(normalizeIp(''), '');
    });

    it('passes through a valid IPv4', () => {
      assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
    });

    it('passes through a valid IPv6', () => {
      assert.equal(normalizeIp('::1'), '::1');
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('strips ::ffff: prefix', () => {
      assert.equal(normalizeIp('::ffff:192.168.1.1'), '192.168.1.1');
    });
  });

  describe('port stripping', () => {
    it('strips port from IPv4:port', () => {
      assert.equal(normalizeIp('82.20.87.8:44741'), '82.20.87.8');
    });
  });

  describe('comma-separated lists', () => {
    it('takes the first IP from a comma list', () => {
      assert.equal(normalizeIp('1.2.3.4, 5.6.7.8'), '1.2.3.4');
    });
  });

  describe('Forwarded header format', () => {
    it('parses for= prefix', () => {
      assert.equal(normalizeIp('for=1.2.3.4'), '1.2.3.4');
    });
  });

  describe('bracketed IPv6', () => {
    it('strips brackets from [::1]:port', () => {
      assert.equal(normalizeIp('[::1]:8080'), '::1');
    });
  });

  describe('whitespace trimming', () => {
    it('trims whitespace', () => {
      assert.equal(normalizeIp('  10.0.0.1  '), '10.0.0.1');
    });
  });
});

// ── getClientIp ──────────────────────────────────────────────────────────────

describe('getClientIp', () => {
  /** Build a minimal mock req */
  function mockReq({ remoteAddress, headers = {}, ip } = {}) {
    return {
      socket: { remoteAddress },
      headers,
      ip,
    };
  }

  it('returns remote address for direct connection', () => {
    const req = mockReq({ remoteAddress: '82.20.87.8' });
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  it('prefers cf-connecting-ip when behind trusted proxy', () => {
    const req = mockReq({
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.50' },
    });
    assert.equal(getClientIp(req), '203.0.113.50');
  });

  it('prefers x-real-ip when behind trusted proxy', () => {
    const req = mockReq({
      remoteAddress: '10.0.0.1',
      headers: { 'x-real-ip': '198.51.100.1' },
    });
    assert.equal(getClientIp(req), '198.51.100.1');
  });

  it('reads x-forwarded-for when behind trusted proxy', () => {
    const req = mockReq({
      remoteAddress: '192.168.1.1',
      headers: { 'x-forwarded-for': '82.20.87.8, 10.0.0.1' },
    });
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  it('does not trust forwarded headers from non-proxy IP', () => {
    const req = mockReq({
      remoteAddress: '82.20.87.8',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    // Should return remote address, not the header
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  it('normalizes IPv4-mapped IPv6 remote address', () => {
    const req = mockReq({ remoteAddress: '::ffff:10.0.0.1' });
    assert.equal(getClientIp(req), '10.0.0.1');
  });

  it('falls back to req.ip', () => {
    const req = mockReq({ ip: '82.20.87.8' });
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  it('returns "unknown" for null req', () => {
    assert.equal(getClientIp(null), 'unknown');
  });

  it('handles 172.16.x.x trusted proxy', () => {
    const req = mockReq({
      remoteAddress: '172.17.0.1',
      headers: { 'x-real-ip': '203.0.113.1' },
    });
    assert.equal(getClientIp(req), '203.0.113.1');
  });

  it('rejects 172.32.x.x as non-trusted', () => {
    const req = mockReq({
      remoteAddress: '172.32.0.1',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    // 172.32 is outside 172.16-31 range, not trusted
    assert.equal(getClientIp(req), '172.32.0.1');
  });
});
