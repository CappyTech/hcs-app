import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import ukTaxId from '../services/ukTaxIdService.js';

describe('ukTaxIdService', () => {
  describe('isValidUtr', () => {
    it('accepts 10 digits', () => {
      assert.ok(ukTaxId.isValidUtr('1234567890'));
    });

    it('accepts spaces and a trailing K', () => {
      assert.ok(ukTaxId.isValidUtr('12345 67890'));
      assert.ok(ukTaxId.isValidUtr('1234567890K'));
    });

    it('rejects wrong lengths and letters', () => {
      assert.ok(!ukTaxId.isValidUtr('123456789'));
      assert.ok(!ukTaxId.isValidUtr('12345678901'));
      assert.ok(!ukTaxId.isValidUtr('12345A7890'));
      assert.ok(!ukTaxId.isValidUtr(''));
      assert.ok(!ukTaxId.isValidUtr(null));
    });
  });

  describe('isValidNino', () => {
    it('accepts well-formed NINOs', () => {
      assert.ok(ukTaxId.isValidNino('AB123456C'));
      assert.ok(ukTaxId.isValidNino('ab 12 34 56 c')); // case/space insensitive
    });

    it('rejects reserved prefixes', () => {
      for (const prefix of ['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']) {
        assert.ok(!ukTaxId.isValidNino(`${prefix}123456C`), `${prefix} should be rejected`);
      }
    });

    it('rejects disallowed letters and suffixes', () => {
      assert.ok(!ukTaxId.isValidNino('DA123456C')); // D not allowed first
      assert.ok(!ukTaxId.isValidNino('AO123456C')); // O not allowed second
      assert.ok(!ukTaxId.isValidNino('AB123456E')); // suffix must be A–D
      assert.ok(!ukTaxId.isValidNino('AB12345C'));  // too few digits
    });
  });

  describe('isValidVerificationNumber', () => {
    it('accepts V + 10 digits with up to two trailing letters', () => {
      assert.ok(ukTaxId.isValidVerificationNumber('V1234567890'));
      assert.ok(ukTaxId.isValidVerificationNumber('V1234567890A'));
      assert.ok(ukTaxId.isValidVerificationNumber('v1234567890ab'));
    });

    it('rejects malformed values', () => {
      assert.ok(!ukTaxId.isValidVerificationNumber('1234567890'));
      assert.ok(!ukTaxId.isValidVerificationNumber('V123456789'));
      assert.ok(!ukTaxId.isValidVerificationNumber('V1234567890ABC'));
    });
  });

  describe('normalise', () => {
    it('uppercases and strips whitespace', () => {
      assert.equal(ukTaxId.normalise(' ab 12 34 56 c '), 'AB123456C');
      assert.equal(ukTaxId.normalise(null), '');
    });
  });
});
