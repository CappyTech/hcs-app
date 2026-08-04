/**
 * Paperless tags that hcs-app makes decisions on, referenced by something
 * stable.
 *
 * Same reasoning as paperlessTypesConfig.js: tags were matched by literal name,
 * so renaming one in the Paperless UI silently changes behaviour — the query
 * stops matching, the feature quietly returns nothing, and no error is raised
 * anywhere. Renaming the document types in August 2026 broke three queries
 * exactly this way.
 *
 * Tag ids are matched first because that is what Paperless uses as the key and
 * what survives a rename. Known names are kept as a fallback: hcs-app caches
 * tag names on each OcrDocument, so a rename takes a full grab to propagate,
 * and a tag deleted and recreated comes back with a new id.
 *
 * Only tags the code branches on belong here. Tags that exist purely for
 * humans to filter by in the UI do not.
 */

const envId = (key, fallback) => {
  const raw = process.env[key];
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const PAPERLESS_TAGS = {
  /** Entered into KashFlow. Gates the duplicate-send lock. */
  added: {
    id: envId('PAPERLESS_TAG_ADDED_ID', 2),
    names: ['added'],
  },
  /** Reference copies; the individual invoices are entered separately. */
  originalMultiInvoice: {
    id: envId('PAPERLESS_TAG_ORIGINAL_MULTI_ID', 4),
    names: ['original/multiple invoice one pdf'],
  },
  /** Credit notes — never sent to KashFlow as purchases. */
  creditRefund: {
    id: envId('PAPERLESS_TAG_CREDIT_REFUND_ID', 8),
    names: ['credit/refund'],
  },
  /** Already keyed into KashFlow by hand, so the app must never send it. */
  manuallyAddedToKashflow: {
    id: envId('PAPERLESS_TAG_MANUAL_KF_ID', 11),
    names: ['manually added to kashflow'],
  },
  /** Data entry complete. Note the live tag is spaced, not hyphenated. */
  dataEntryDone: {
    id: envId('PAPERLESS_TAG_DATA_ENTRY_DONE_ID', 1),
    names: ['data entry done', 'data-entry-done', 'data_entry_done'],
  },

  // ── Bank reconciliation ────────────────────────────────────────────
  bankStatement: {
    id: envId('PAPERLESS_TAG_BANK_STATEMENT_ID', 12),
    names: ['bank-statement'],
  },
  bankStatementParsed: {
    id: envId('PAPERLESS_TAG_BANK_STATEMENT_PARSED_ID', 13),
    names: ['bank-statement/parsed'],
  },
  bankStatementNeedsReview: {
    id: envId('PAPERLESS_TAG_BANK_STATEMENT_REVIEW_ID', 14),
    names: ['bank-statement/needs-review'],
  },
  bankStatementFailed: {
    id: envId('PAPERLESS_TAG_BANK_STATEMENT_FAILED_ID', 15),
    names: ['bank-statement/failed'],
  },
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagOf(key) {
  const tag = PAPERLESS_TAGS[key];
  if (!tag) throw new Error(`Unknown Paperless tag "${key}"`);
  return tag;
}

/** Anchored, case-insensitive name patterns for one tag. */
export function tagNamePatterns(key) {
  return tagOf(key).names.map(n => new RegExp(`^\\s*${escapeRegex(n)}\\s*$`, 'i'));
}

/**
 * An `$elemMatch` selecting one tag on a cached document, by id or known name.
 *
 * Composable: it is a value, not a top-level key, so it never clashes with
 * another condition the way a bare `$or` can.
 */
export function tagElemMatch(key) {
  const tag = tagOf(key);
  return { $or: [{ id: tag.id }, { name: { $in: tagNamePatterns(key) } }] };
}

/** Documents carrying the given tag. */
export function hasTagQuery(key) {
  return { tags: { $elemMatch: tagElemMatch(key) } };
}

/**
 * Documents carrying none of the given tags.
 *
 * Uses `tags: { $not: { $elemMatch } }` rather than a `tags.name` key, so it
 * composes with queries that also match on tags — the note that was already on
 * NOT_FOR_KASHFLOW_TAGS in documentsOverviewService.
 */
export function lacksAllTagsQuery(keys) {
  return {
    tags: {
      $not: {
        $elemMatch: {
          $or: keys.flatMap(key => [
            { id: tagOf(key).id },
            { name: { $in: tagNamePatterns(key) } },
          ]),
        },
      },
    },
  };
}

/** True when a cached tag array carries the given tag. */
export function hasTag(tags, key) {
  const tag = tagOf(key);
  const patterns = tagNamePatterns(key);
  return (Array.isArray(tags) ? tags : []).some((t) => {
    if (t == null) return false;
    // Tags are normally { id, name, slug }, but a string array has been seen.
    if (typeof t === 'string') return patterns.some(rx => rx.test(t));
    if (t.id === tag.id) return true;
    const name = t.name ?? t.Name;
    return name != null && patterns.some(rx => rx.test(String(name)));
  });
}

/** The tag names to send to Paperless when applying this tag. */
export function tagName(key) {
  return tagOf(key).names[0];
}

export default {
  PAPERLESS_TAGS,
  tagElemMatch,
  hasTagQuery,
  lacksAllTagsQuery,
  hasTag,
  tagName,
  tagNamePatterns,
};
