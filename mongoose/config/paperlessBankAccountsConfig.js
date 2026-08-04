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
 * correspondent's name. Those names follow a human convention rather than a
 * machine one — 'Petty Cash - 5714888' carries a real-world account number,
 * not the KashFlow id (571488) or its nominal code (69500). Reading ids out of
 * display names is the same mistake as matching document types and tags by
 * name, which broke three queries when the types were renamed.
 *
 * Correspondent ids come from Paperless and are stable across renames. The map
 * can be overridden wholesale with PAPERLESS_BANK_CORRESPONDENTS, a
 * comma-separated list of `<correspondentId>:<kashflowAccountId>` pairs, so a
 * new account does not require a deploy.
 */

/** Paperless correspondent id -> KashFlow bankAccount.Id */
const DEFAULT_CORRESPONDENT_TO_ACCOUNT = {
  65: 611594, // Heron Constructive Solutions LTD
  66: 680198, // Credit Card 3998/2060/5865/5760
  67: 938298, // Business Credit Card 2829/5766/7859
  68: 571488, // Petty Cash
};

function parseOverride(raw) {
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

export const CORRESPONDENT_TO_ACCOUNT = (() => {
  const override = parseOverride(process.env.PAPERLESS_BANK_CORRESPONDENTS);
  return Object.keys(override).length ? override : DEFAULT_CORRESPONDENT_TO_ACCOUNT;
})();

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
    // The field is 'float' in Paperless, so the value may arrive as 611594.0
    // or as a string; both must land on the integer id.
    const n = Number.parseInt(String(field?.value ?? '').trim(), 10);
    if (Number.isFinite(n) && n > 0) return { accountId: n, source: 'custom-field' };
  }

  const correspondentId = doc?.correspondent?.id;
  if (correspondentId != null && CORRESPONDENT_TO_ACCOUNT[correspondentId] != null) {
    return { accountId: CORRESPONDENT_TO_ACCOUNT[correspondentId], source: 'correspondent' };
  }

  return { accountId: null, source: null };
}

export default { CORRESPONDENT_TO_ACCOUNT, ACCOUNT_ID_FIELD_NAMES, resolveAccountId };
