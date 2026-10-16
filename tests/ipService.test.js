import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIp, getClientIp } from '../services/ipService.js';

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
  /** Build a minimal mock req. `ip` is what Express derived under `trust proxy`. */
  function mockReq({ remoteAddress, headers = {}, ip } = {}) {
    return {
      socket: { remoteAddress },
      headers,
      ip,
    };
  }

  it('uses the address Express resolved under trust proxy', () => {
    const req = mockReq({ remoteAddress: '172.17.0.1', ip: '82.20.87.8' });
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  it('returns remote address for a direct connection with no req.ip', () => {
    const req = mockReq({ remoteAddress: '82.20.87.8' });
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  // The rate limiter, lockout audit and request log are keyed on this value.
  // A client-supplied header must never pick the key, even when the direct
  // peer is a trusted proxy: nothing upstream sets or strips these headers.
  for (const header of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for', 'forwarded']) {
    it(`ignores ${header} behind a trusted proxy`, () => {
      const value = header === 'forwarded' ? 'for=203.0.113.50' : '203.0.113.50';
      const req = mockReq({
        remoteAddress: '172.17.0.1',
        ip: '172.17.0.1',
        headers: { [header]: value },
      });
      assert.equal(getClientIp(req), '172.17.0.1');
    });

    it(`ignores ${header} from a non-proxy peer`, () => {
      const value = header === 'forwarded' ? 'for=1.1.1.1' : '1.1.1.1';
      const req = mockReq({
        remoteAddress: '82.20.87.8',
        ip: '82.20.87.8',
        headers: { [header]: value },
      });
      assert.equal(getClientIp(req), '82.20.87.8');
    });
  }

  it('normalizes an IPv4-mapped IPv6 req.ip', () => {
    const req = mockReq({ remoteAddress: '::ffff:10.0.0.1', ip: '::ffff:82.20.87.8' });
    assert.equal(getClientIp(req), '82.20.87.8');
  });

  it('normalizes IPv4-mapped IPv6 remote address', () => {
    const req = mockReq({ remoteAddress: '::ffff:10.0.0.1' });
    assert.equal(getClientIp(req), '10.0.0.1');
  });

  it('falls back to remote address when req.ip is not an IP', () => {
    const req = mockReq({ remoteAddress: '10.0.0.1', ip: 'not-an-ip' });
    assert.equal(getClientIp(req), '10.0.0.1');
  });

  it('returns "unknown" for null req', () => {
    assert.equal(getClientIp(null), 'unknown');
  });
});
