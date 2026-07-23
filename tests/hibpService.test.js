import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import hibpService from '../services/hibpService.js';

// Build a fake range response containing the given password at `count` hits
function rangeBodyFor(password, count, extraLines = []) {
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  return [...extraLines, `${sha1.slice(5)}:${count}`].join('\r\n');
}

describe('hibpService', () => {
  describe('isPasswordPwned', () => {
    it('flags a password present in the range response', async () => {
      const fetch = async () => rangeBodyFor('password123', 12345, ['0000000000000000000000000000000000A:3']);
      const result = await hibpService.isPasswordPwned('password123', { fetch });
      assert.deepEqual(result, { pwned: true, count: 12345, checked: true });
    });

    it('passes a password absent from the range response', async () => {
      const fetch = async () => '0000000000000000000000000000000000A:3\r\n111111111111111111111111111111111B:9';
      const result = await hibpService.isPasswordPwned('S0me-Un1que-Passw0rd!', { fetch });
      assert.deepEqual(result, { pwned: false, count: 0, checked: true });
    });

    it('treats padded zero-count entries as not pwned', async () => {
      const fetch = async () => rangeBodyFor('padded-pass', 0);
      const result = await hibpService.isPasswordPwned('padded-pass', { fetch });
      assert.equal(result.pwned, false);
    });

    it('fails open when the API is unreachable', async () => {
      const fetch = async () => { throw new Error('ETIMEDOUT'); };
      const result = await hibpService.isPasswordPwned('whatever', { fetch });
      assert.deepEqual(result, { pwned: false, count: 0, checked: false });
    });

    it('is disabled by HIBP_DISABLED=true', async () => {
      process.env.HIBP_DISABLED = 'true';
      try {
        let called = false;
        const fetch = async () => { called = true; return ''; };
        const result = await hibpService.isPasswordPwned('whatever', { fetch });
        assert.equal(result.checked, false);
        assert.equal(called, false);
      } finally {
        delete process.env.HIBP_DISABLED;
      }
    });
  });

  describe('countInRange', () => {
    it('parses suffix:count lines with either line ending', () => {
      assert.equal(hibpService.countInRange('AAA:1\nBBB:2', 'BBB'), 2);
      assert.equal(hibpService.countInRange('AAA:1\r\nBBB:2', 'AAA'), 1);
      assert.equal(hibpService.countInRange('AAA:1', 'CCC'), 0);
      assert.equal(hibpService.countInRange('', 'CCC'), 0);
    });
  });
});
