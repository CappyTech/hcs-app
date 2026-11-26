import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  correspondentToAccount,
  parseOverride,
  resolveAccountId,
} from '../mongoose/config/paperlessBankAccountsConfig.js';

// Made-up ids. The real map is configuration, never code.
process.env.PAPERLESS_BANK_CORRESPONDENTS = '11:100001, 12:100002,13:100003 ,14:100004';

/**
 * Attributing a statement to the wrong bank account produces a confidently
 * wrong reconciliation, so resolution is explicit or it does not happen.
 */
describe('paperlessBankAccountsConfig', () => {
  const doc = (over = {}) => ({ customFields: [], correspondent: null, ...over });

  it('reads the correspondent map from configuration', () => {
    assert.deepEqual(correspondentToAccount(), { 11: 100001, 12: 100002, 13: 100003, 14: 100004 });
  });

  it('has no map when nothing is configured', () => {
    const saved = process.env.PAPERLESS_BANK_CORRESPONDENTS;
    delete process.env.PAPERLESS_BANK_CORRESPONDENTS;
    try {
      assert.deepEqual(correspondentToAccount(), {});
      assert.deepEqual(resolveAccountId(doc({ correspondent: { id: 11, name: 'Current account' } })),
        { accountId: null, source: null });
    } finally {
      process.env.PAPERLESS_BANK_CORRESPONDENTS = saved;
    }
  });

  it('skips malformed pairs', () => {
    assert.deepEqual(parseOverride('11:100001, nonsense, 12:, :5, 13:100003'), { 11: 100001, 13: 100003 });
  });

  it('prefers the custom field over the correspondent', () => {
    const r = resolveAccountId(doc({
      customFields: [{ fieldName: 'Bank Account ID', value: 100002 }],
      correspondent: { id: 11, name: 'Current account - 100001' },
    }));
    assert.deepEqual(r, { accountId: 100002, source: 'custom-field' });
  });

  it('reads the custom field however Paperless renders it', () => {
    // The field is 'float' upstream, so a value can arrive as a number, a
    // float-formatted number, or a string.
    for (const value of [100001, 100001.0, '100001', ' 100001 ', '100001.00']) {
      assert.equal(
        resolveAccountId(doc({ customFields: [{ fieldName: 'Bank Account ID', value }] })).accountId,
        100001,
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  it('matches the field name loosely', () => {
    for (const fieldName of ['Bank Account ID', 'bank account id', 'bank_account_id', 'BankAccountId']) {
      assert.equal(
        resolveAccountId(doc({ customFields: [{ fieldName, value: 100004 }] })).accountId,
        100004,
        fieldName,
      );
    }
  });

  it('falls back to the correspondent id', () => {
    const r = resolveAccountId(doc({ correspondent: { id: 14, name: 'Petty Cash - 1000048' } }));
    assert.deepEqual(r, { accountId: 100004, source: 'correspondent' });
  });

  it('never parses the account id out of the correspondent name', () => {
    // Correspondent names carry the KashFlow id by convention, but nothing
    // validates them. The live 'Petty Cash - 1000048' has an extra digit — the
    // real account is 100004 — so parsing the name would yield 1000048: a
    // plausible id matching no account, failing silently.
    const r = resolveAccountId(doc({ correspondent: { id: 999, name: 'Petty Cash - 1000048' } }));
    assert.equal(r.accountId, null, 'a name-derived number must never be used as an account id');
    assert.notEqual(r.accountId, 1000048);
  });

  it('resolves Petty Cash to the real account despite the name being wrong', () => {
    // The map is keyed on the correspondent id, so a typo in the display name
    // — or a rename — cannot affect which account a statement lands in.
    const r = resolveAccountId(doc({ correspondent: { id: 14, name: 'Petty Cash - 1000048' } }));
    assert.equal(r.accountId, 100004);
  });

  it('returns nothing rather than guessing when it cannot tell', () => {
    assert.deepEqual(resolveAccountId(doc()), { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(doc({ correspondent: { id: 42, name: 'Some Company Ltd' } })),
      { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(null), { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(doc({ customFields: [{ fieldName: 'Bank Account ID', value: '' }] })),
      { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(doc({ customFields: [{ fieldName: 'Invoice Total', value: 100001 }] })),
      { accountId: null, source: null });
  });

  it('ignores a zero or negative account id', () => {
    for (const value of [0, -1, '0']) {
      assert.equal(resolveAccountId(doc({ customFields: [{ fieldName: 'Bank Account ID', value }] })).accountId, null);
    }
  });
});
