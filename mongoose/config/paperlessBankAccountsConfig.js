/**
 * Which KashFlow bank account a Paperless correspondent represents.
 *
 * A bank statement has to be attributed to an account before its lines mean
 * anything. There are three ways to establish that, in order of confidence:
 *
 *   1. The `Bank Account ID` custom field on the document. Explicit, and the
 *      one to prefer.
 *   2. This map, keyed on the Paperless correspondent id.
 *   3. Nothing — the statement is held unattributed for a human to assign.
 *
 * Deliberately NOT a fourth option: parsing the account id out of the
 * correspondent's name.
 *
 * Correspondent names do carry the KashFlow id by convention, and it is
 * tempting to read it from there. But a display name is written by hand and
 * nothing validates it — a name like 'Petty Cash - 1234567' with an extra digit
 * (the real account being 123456) would have produced 1234567: a plausible
 * account id that matches nothing, resolving silently to a statement attached
 * to an account that does not exist.
 *
 * Reading identifiers out of display names is the same mistake as matching
 * document types and tags by name, which broke three queries when the types
 * were renamed.
 *
 * Correspondent ids come from Paperless and are stable across renames. The
 * map is PAPERLESS_BANK_CORRESPONDENTS (Admin → Configuration → Paperless-ngx),
 * a comma-separated list of `<correspondentId>:<kashflowAccountId>` pairs,
 * read on every call so a new account needs no deploy. Unset, there is no map:
 * the ids belong to one company's Paperless and KashFlow, so none ship here.
 */

import configService from '../../services/configService.js';

export function parseOverride(raw) {
  const out = {};
  for (const pair of String(raw || '').split(',')) {
    const [left, right] = pair.split(':').map(s => s?.trim());
    const correspondentId = Number.parseInt(left ?? '', 10);
    const accountId = Number.parseInt(right ?? '', 10);
    if (Number.isFinite(correspondentId) && Number.isFinite(accountId)) {
      out[correspondentId] = accountId;
    }
  }
  return out;
}

/** Paperless correspondent id -> KashFlow bankAccount.Id, from configuration. */
export function correspondentToAccount() {
  return parseOverride(configService.get('PAPERLESS_BANK_CORRESPONDENTS', ''));
}

/** Name of the custom field carrying the account id, matched loosely. */
export const ACCOUNT_ID_FIELD_NAMES = ['bank account id', 'bank_account_id', 'bankaccountid'];

const normalise = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Resolve a cached statement document to a KashFlow account id.
 *
 * Returns { accountId, source } where source is 'custom-field',
 * 'correspondent', or null when it could not be determined — in which case the
 * statement is held for a human rather than guessed at, because attributing a
 * statement to the wrong account produces a confidently wrong reconciliation.
 */
export function resolveAccountId(doc) {
  const wanted = ACCOUNT_ID_FIELD_NAMES.map(normalise);

  for (const field of doc?.customFields || []) {
    if (!wanted.includes(normalise(field?.fieldName))) continue;
    // The field is 'float' in Paperless, so the value may arrive as 123456.0
    // or as a string; both must land on the integer id.
    const n = Number.parseInt(String(field?.value ?? '').trim(), 10);
    if (Number.isFinite(n) && n > 0) return { accountId: n, source: 'custom-field' };
  }

  const correspondentId = doc?.correspondent?.id;
  const map = correspondentToAccount();
  if (correspondentId != null && map[correspondentId] != null) {
    return { accountId: map[correspondentId], source: 'correspondent' };
  }

  return { accountId: null, source: null };
}

export default { correspondentToAccount, parseOverride, ACCOUNT_ID_FIELD_NAMES, resolveAccountId };
