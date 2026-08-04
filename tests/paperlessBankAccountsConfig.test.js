import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORRESPONDENT_TO_ACCOUNT,
  resolveAccountId,
} from '../mongoose/config/paperlessBankAccountsConfig.js';

/**
 * Attributing a statement to the wrong bank account produces a confidently
 * wrong reconciliation, so resolution is explicit or it does not happen.
 */
describe('paperlessBankAccountsConfig', () => {
  const doc = (over = {}) => ({ customFields: [], correspondent: null, ...over });

  it('maps the four configured correspondents to real KashFlow accounts', () => {
    assert.deepEqual(CORRESPONDENT_TO_ACCOUNT, { 65: 611594, 66: 680198, 67: 938298, 68: 571488 });
  });

  it('prefers the custom field over the correspondent', () => {
    const r = resolveAccountId(doc({
      customFields: [{ fieldName: 'Bank Account ID', value: 680198 }],
      correspondent: { id: 65, name: 'Heron Constructive Solutions LTD - 611594' },
    }));
    assert.deepEqual(r, { accountId: 680198, source: 'custom-field' });
  });

  it('reads the custom field however Paperless renders it', () => {
    // The field is 'float' upstream, so a value can arrive as a number, a
    // float-formatted number, or a string.
    for (const value of [611594, 611594.0, '611594', ' 611594 ', '611594.00']) {
      assert.equal(
        resolveAccountId(doc({ customFields: [{ fieldName: 'Bank Account ID', value }] })).accountId,
        611594,
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  it('matches the field name loosely', () => {
    for (const fieldName of ['Bank Account ID', 'bank account id', 'bank_account_id', 'BankAccountId']) {
      assert.equal(
        resolveAccountId(doc({ customFields: [{ fieldName, value: 571488 }] })).accountId,
        571488,
        fieldName,
      );
    }
  });

  it('falls back to the correspondent id', () => {
    const r = resolveAccountId(doc({ correspondent: { id: 68, name: 'Petty Cash - 5714888' } }));
    assert.deepEqual(r, { accountId: 571488, source: 'correspondent' });
  });

  it('never parses the account id out of the correspondent name', () => {
    // Correspondent names carry the KashFlow id by convention, but nothing
    // validates them. The live 'Petty Cash - 5714888' has an extra digit — the
    // real account is 571488 — so parsing the name would yield 5714888: a
    // plausible id matching no account, failing silently.
    const r = resolveAccountId(doc({ correspondent: { id: 999, name: 'Petty Cash - 5714888' } }));
    assert.equal(r.accountId, null, 'a name-derived number must never be used as an account id');
    assert.notEqual(r.accountId, 5714888);
  });

  it('resolves Petty Cash to the real account despite the name being wrong', () => {
    // The map is keyed on the correspondent id, so a typo in the display name
    // — or a rename — cannot affect which account a statement lands in.
    const r = resolveAccountId(doc({ correspondent: { id: 68, name: 'Petty Cash - 5714888' } }));
    assert.equal(r.accountId, 571488);
  });

  it('returns nothing rather than guessing when it cannot tell', () => {
    assert.deepEqual(resolveAccountId(doc()), { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(doc({ correspondent: { id: 42, name: 'Heron Constructive Solutions' } })),
      { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(null), { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(doc({ customFields: [{ fieldName: 'Bank Account ID', value: '' }] })),
      { accountId: null, source: null });
    assert.deepEqual(resolveAccountId(doc({ customFields: [{ fieldName: 'Invoice Total', value: 611594 }] })),
      { accountId: null, source: null });
  });

  it('ignores a zero or negative account id', () => {
    for (const value of [0, -1, '0']) {
      assert.equal(resolveAccountId(doc({ customFields: [{ fieldName: 'Bank Account ID', value }] })).accountId, null);
    }
  });
});
