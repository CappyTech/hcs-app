/**
 * Paperless document types, referenced by something stable.
 *
 * Document types were previously matched by name — `'documentType.name':
 * 'statement'`, `{ $regex: /^purchase$/i }` and so on. Renaming a type in the
 * Paperless UI silently broke every one of those: the query simply stopped
 * matching and the feature returned nothing, with no error anywhere. That
 * happened in August 2026 when `purchase` / `statement` / `subcontractor` were
 * renamed to `Purchase Invoice` / `Supplier Statement` / `Subcontractor
 * Invoice` to distinguish them from the new `Bank Statement` type.
 *
 * The id is what Paperless itself uses as the stable key and survives a
 * rename, so it is matched first. Known past and present names are kept as a
 * fallback for two reasons: hcs-app caches `documentType.name` on each
 * OcrDocument, so freshly-renamed types take a full grab to propagate, and a
 * type that is ever deleted and recreated comes back with a new id.
 *
 * Ids can be overridden by environment variable for a differently-configured
 * Paperless instance.
 */

const envId = (key, fallback) => {
  const raw = process.env[key];
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const PAPERLESS_DOCUMENT_TYPES = {
  purchaseInvoice: {
    id: envId('PAPERLESS_TYPE_PURCHASE_ID', 1),
    names: ['purchase', 'purchase invoice'],
  },
  supplierStatement: {
    // A supplier's statement of account — "here is what you owe us".
    // Not a bank statement; see bankStatement below.
    id: envId('PAPERLESS_TYPE_SUPPLIER_STATEMENT_ID', 2),
    names: ['statement', 'supplier statement'],
  },
  subcontractorInvoice: {
    id: envId('PAPERLESS_TYPE_SUBCONTRACTOR_ID', 3),
    names: ['subcontractor', 'subcontractor invoice'],
  },
  bankStatement: {
    // A statement from the bank, used by bank reconciliation.
    id: envId('PAPERLESS_TYPE_BANK_STATEMENT_ID', 4),
    names: ['bank statement'],
  },
};

/**
 * A Mongo query fragment selecting one document type on a cached OcrDocument
 * or bankStatementDocument.
 *
 * Returns an `$or` over the id and every known name, so it keeps working
 * across a rename in either direction and while the cache is mid-refresh.
 *
 * Spread it into a query rather than nesting it, so it combines with other
 * conditions without clashing on an `$or` key:
 *
 *   const docs = await OcrDocument.find({ ...documentTypeQuery('purchaseInvoice'), title: ... });
 */
export function documentTypeQuery(key) {
  const type = PAPERLESS_DOCUMENT_TYPES[key];
  if (!type) throw new Error(`Unknown Paperless document type "${key}"`);

  return {
    $or: [
      { 'documentType.id': type.id },
      // Anchored and case-insensitive: 'statement' must not also match
      // 'Supplier Statement' belonging to a different type.
      ...type.names.map(name => ({
        'documentType.name': { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
      })),
    ],
  };
}

/** True when a cached documentType refers to the given key. */
export function isDocumentType(documentType, key) {
  const type = PAPERLESS_DOCUMENT_TYPES[key];
  if (!type || !documentType) return false;
  if (documentType.id === type.id) return true;
  const name = String(documentType.name || '').trim().toLowerCase();
  return type.names.includes(name);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default { PAPERLESS_DOCUMENT_TYPES, documentTypeQuery, isDocumentType };
