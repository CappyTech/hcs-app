// mongoose/services/paperless/paperlessUpdateService.js
import __paperlessClient from './paperlessClient.js';
const { makeClient } = __paperlessClient;
import logger from '../../../services/loggerService.js';
import { PAPERLESS_TAGS } from '../../config/paperlessTagsConfig.js';

// Axios errors hide the response body ("Request failed with status code 500") —
// append what Paperless actually returned so failures are diagnosable from logs.
function describeAxiosError(err) {
  const body = err?.response?.data;
  if (body == null) return err.message;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `${err.message} — response: ${text.slice(0, 500)}`;
}

/**
 * Update the Paperless-ngx document's custom fields with KashFlow info.
 * Fields written (as strings):
 * - "KashFlow Purchase Id"
 * - "KashFlow Purchase Number"
 * - "KashFlow Purchase Permalink"
 * - "KashFlow Last Send Status"
 * Any null/undefined values are skipped.
 *
 * @param {number} paperlessId - The Paperless document ID
 * @param {object} purchase - The KashFlow create response body
 * @param {number} status - HTTP status from the KashFlow call
 */
async function updatePaperlessWithKashFlowInfo(paperlessId, purchase, status) {
  const api = makeClient();
  const id = Number(paperlessId);
  if (!Number.isFinite(id)) throw new Error("paperlessId must be a number");

  const purchaseId =
    purchase && typeof purchase.Id === "number" ? purchase.Id : null;
  const purchaseNumber =
    purchase && typeof purchase.Number === "number" ? purchase.Number : null;
  const permalink =
    purchase && typeof purchase.Permalink === "string"
      ? purchase.Permalink
      : null;
  const lastStatus = typeof status === "number" ? status : null;

  const fields = {
    "KashFlow Purchase Id": purchaseId != null ? String(purchaseId) : null,
    "KashFlow Purchase Number":
      purchaseNumber != null ? String(purchaseNumber) : null,
    "KashFlow Purchase Permalink": permalink || null,
    "KashFlow Last Send Status": lastStatus != null ? String(lastStatus) : null,
  };

  // Remove nulls
  const updates = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v != null),
  );
  if (Object.keys(updates).length === 0) {
    logger.info(
      `[paperlessUpdate] Nothing to update for doc ${id} (no fields present)`,
    );
    return { updated: false };
  }

  // Never rebuild the document's custom_fields from MongoDB's cached copy: a
  // PATCH replaces the whole array, so any field changed in Paperless since the
  // last ingest (e.g. Credit Note ticked) would be silently reverted.
  // Primary: bulk_edit modify_custom_fields touches only these four fields.
  try {
    const res = await api.setDocumentCustomFields(id, updates);
    logger.info(
      `[paperlessUpdate] Updated custom fields for doc ${id} (bulk_edit): ${Object.keys(updates).join(", ")}`,
    );
    return { updated: true, data: res };
  } catch (bulkErr) {
    logger.warn(
      `[paperlessUpdate] bulk_edit custom fields failed for doc ${id}, falling back to read-then-write: ${describeAxiosError(bulkErr)}`,
    );
  }

  // Fallback: re-read the document's current fields from Paperless, then PATCH.
  // Not atomic, but the window is milliseconds rather than "since last ingest".
  try {
    const res = await api.updateDocumentCustomFields(id, updates);
    logger.info(
      `[paperlessUpdate] Updated custom fields for doc ${id} (fresh read): ${Object.keys(updates).join(", ")}`,
    );
    return { updated: true, data: res };
  } catch (err) {
    logger.warn(
      `[paperlessUpdate] Failed to update custom fields for doc ${id}: ${describeAxiosError(err)}`,
    );
    throw err;
  }
}

/**
 * Clear all KashFlow-related custom fields on a Paperless-ngx document.
 * Used when a KashFlow purchase is deleted (orphaned doc) and we need to
 * remove the stale reference from Paperless to eliminate CF drift.
 *
 * Same approach as updatePaperlessWithKashFlowInfo: remove only these four
 * fields via bulk_edit, falling back to a fresh read-then-write — never a PATCH
 * rebuilt from MongoDB's cached copy, which reverted newer Paperless edits.
 *
 * @param {number} paperlessId - The Paperless document ID
 */
async function clearPaperlessKashFlowFields(paperlessId) {
  const api = makeClient();
  const id = Number(paperlessId);
  if (!Number.isFinite(id)) throw new Error("paperlessId must be a number");

  const names = [
    "KashFlow Purchase Id",
    "KashFlow Purchase Number",
    "KashFlow Purchase Permalink",
    "KashFlow Last Send Status",
  ];

  try {
    const res = await api.removeDocumentCustomFields(id, names);
    logger.info(`[paperlessUpdate] Cleared KashFlow custom fields for doc ${id} (bulk_edit, orphaned purchase)`);
    return { cleared: true, data: res };
  } catch (bulkErr) {
    logger.warn(
      `[paperlessUpdate] bulk_edit clear failed for doc ${id}, falling back to read-then-write: ${describeAxiosError(bulkErr)}`,
    );
  }

  try {
    const clears = Object.fromEntries(names.map((n) => [n, null]));
    const res = await api.updateDocumentCustomFields(id, clears);
    logger.info(`[paperlessUpdate] Cleared KashFlow custom fields for doc ${id} (fresh read, orphaned purchase)`);
    return { cleared: true, data: res };
  } catch (err) {
    logger.warn(`[paperlessUpdate] Failed to clear KashFlow fields for doc ${id}: ${describeAxiosError(err)}`);
    throw err;
  }
}

export default {
  updatePaperlessWithKashFlowInfo,
  clearPaperlessKashFlowFields,
  updatePaperlessDocumentTags,
  modifyPaperlessDocumentTags,
};

/**
 * Add and remove specific tags on a Paperless-ngx document, leaving every other
 * tag alone. Uses `bulk_edit` `modify_tags`, which Paperless applies in one
 * transaction — unlike the read-then-write merge in updatePaperlessDocumentTags,
 * nothing changed in between can be lost. Paperless still fires its "Document
 * updated" workflows afterwards (bulk_update_documents sends document_updated).
 *
 * @param {number} paperlessId
 * @param {{ add?: Array<string|number>, remove?: Array<string|number> }} changes
 *   Keys of PAPERLESS_TAGS (e.g. 'added', 'dataEntryDone') or raw tag ids.
 */
/** The id of the Paperless tag called any of `names` (case-insensitive), or null. */
async function findTagIdByName(api, names) {
  const want = names.map((n) => String(n).trim().toLowerCase());
  const all = await api.listTags({ page: 1, pageSize: 1000, ordering: "name" });
  const hit = (all?.results || []).find((t) => want.includes(String(t?.name || "").trim().toLowerCase()));
  return typeof hit?.id === "number" ? hit.id : null;
}

async function modifyPaperlessDocumentTags(paperlessId, { add = [], remove = [] } = {}) {
  const id = Number(paperlessId);
  if (!Number.isFinite(id)) throw new Error("paperlessId must be a number");

  const api = makeClient();
  // A tag with no configured id (e.g. "not for kashflow") is found by name,
  // and created when it's being added and doesn't exist yet
  const toId = async (t, create) => {
    if (typeof t === "number" && Number.isFinite(t)) return t;
    const tag = PAPERLESS_TAGS[t];
    if (!tag) throw new Error(`Unknown Paperless tag "${t}"`);
    if (tag.id > 0) return tag.id;
    const found = await findTagIdByName(api, tag.names);
    if (found != null || !create) return found;
    const made = await api.createTag({ name: tag.names[0] });
    if (typeof made?.id !== "number") throw new Error(`Couldn't create the Paperless tag "${tag.names[0]}"`);
    return made.id;
  };
  const addIds = [];
  for (const t of add) addIds.push(await toId(t, true));
  const removeIds = [];
  for (const t of remove) {
    const tid = await toId(t, false);
    if (tid != null) removeIds.push(tid); // never created, so not on the document
  }
  if (addIds.length === 0 && removeIds.length === 0) return { updated: false };

  try {
    const res = await api.modifyDocumentTags([id], { add: addIds, remove: removeIds });
    logger.info(
      `[paperlessUpdate] Modified tags for doc ${id}: +[${addIds.join(", ")}] -[${removeIds.join(", ")}]`,
    );
    return { updated: true, data: res };
  } catch (err) {
    logger.warn(
      `[paperlessUpdate] Failed to modify tags for doc ${id}: ${describeAxiosError(err)}`,
    );
    throw err;
  }
}

/**
 * Set or merge tags on a Paperless-ngx document.
 * - Accepts tag names (strings) or tag ids (numbers). Names will be created if missing.
 * - By default, replaces the document's tags with the provided set. Pass { merge: true } to add to existing.
 *
 * @param {number} paperlessId - The Paperless document ID
 * @param {Array<string|number>} tags - Tag names or ids to apply
 * @param {{ merge?: boolean }} [options] - Set merge=true to add tags instead of replacing
 * @returns {Promise<{updated: boolean, data?: any}>}
 */
async function updatePaperlessDocumentTags(paperlessId, tags, options = {}) {
  const api = makeClient();
  const id = Number(paperlessId);
  if (!Number.isFinite(id)) throw new Error("paperlessId must be a number");
  const merge = !!options.merge;

  const input = Array.isArray(tags) ? tags : tags == null ? [] : [tags];
  if (input.length === 0) {
    logger.info(`[paperlessUpdate] No tags provided for doc ${id}; skipping`);
    return { updated: false };
  }

  // Build a catalog of existing tags by lowercase name -> id
  const all = await api
    .listTags({ page: 1, pageSize: 1000, ordering: "name" })
    .catch((e) => {
      throw new Error(`Failed to list tags: ${e.message}`);
    });
  const results = Array.isArray(all?.results) ? all.results : [];
  const idByName = new Map();
  for (const t of results) {
    if (t?.name && typeof t.id === "number") {
      idByName.set(String(t.name).trim().toLowerCase(), Number(t.id));
    }
  }

  // Resolve input to tag ids; create tags for names that do not exist
  const ensureIdForName = async (name) => {
    const key = String(name).trim().toLowerCase();
    if (idByName.has(key)) return idByName.get(key);
    try {
      const created = await api.createTag({ name: String(name).trim() });
      if (created && typeof created.id === "number") {
        idByName.set(key, Number(created.id));
        return Number(created.id);
      }
    } catch (err) {
      logger.warn(
        `[paperlessUpdate] Failed to create tag "${name}": ${err.message}`,
      );
    }
    return null;
  };

  const resolvedIds = [];
  for (const t of input) {
    if (typeof t === "number" && Number.isFinite(t)) {
      resolvedIds.push(Number(t));
    } else if (typeof t === "string" && t.trim().length > 0) {
      const idMaybe = await ensureIdForName(t);
      if (idMaybe != null) resolvedIds.push(idMaybe);
    }
  }

  // Dedupe
  const wantedIds = Array.from(new Set(resolvedIds));
  if (wantedIds.length === 0) {
    logger.info(
      `[paperlessUpdate] No valid tags resolved for doc ${id}; skipping`,
    );
    return { updated: false };
  }

  let finalIds = wantedIds;
  if (merge) {
    try {
      const doc = await api.getDocument(id);
      const current = Array.isArray(doc?.tags) ? doc.tags : [];
      finalIds = Array.from(
        new Set([...current.map(Number).filter(Number.isFinite), ...wantedIds]),
      );
    } catch (err) {
      logger.warn(
        `[paperlessUpdate] Failed to fetch current tags for doc ${id}; proceeding without merge: ${err.message}`,
      );
    }
  }

  try {
    const res = await api.updateDocumentTags(id, finalIds);
    logger.info(
      `[paperlessUpdate] Updated tags for doc ${id}: ${finalIds.join(", ")}`,
    );
    return { updated: true, data: res };
  } catch (err) {
    logger.warn(
      `[paperlessUpdate] Failed to update tags for doc ${id}: ${err.message}`,
    );
    throw err;
  }
}

export { updatePaperlessDocumentTags, modifyPaperlessDocumentTags };
