// mongoose/services/paperless/paperlessUpdateService.js
"use strict";
const { makeClient } = require("./paperlessClient");
const logger = require("../../../services/loggerService");

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
 * @param {object} [opts]
 * @param {Array} [opts.existingCf] - OcrDocument.customFields array from MongoDB.
 *   When provided, skips the GET /documents/:id/ round-trip (avoids timeouts on large docs).
 */
async function updatePaperlessWithKashFlowInfo(paperlessId, purchase, status, opts = {}) {
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

  try {
    let res;
    if (Array.isArray(opts.existingCf)) {
      // Fast path: use cached MongoDB fields — no GET /documents/:id/ round-trip
      res = await api.updateDocumentCustomFieldsDirect(id, updates, opts.existingCf);
    } else {
      res = await api.updateDocumentCustomFields(id, updates);
    }
    logger.info(
      `[paperlessUpdate] Updated custom fields for doc ${id}: ${Object.keys(updates).join(", ")}`,
    );
    return { updated: true, data: res };
  } catch (err) {
    logger.warn(
      `[paperlessUpdate] Failed to update custom fields for doc ${id}: ${err.message}`,
    );
    throw err;
  }
}

/**
 * Clear all KashFlow-related custom fields on a Paperless-ngx document.
 * Used when a KashFlow purchase is deleted (orphaned doc) and we need to
 * remove the stale reference from Paperless to eliminate CF drift.
 *
 * @param {number} paperlessId - The Paperless document ID
 * @param {Array} existingCf - OcrDocument.customFields array from MongoDB (fast path, no GET)
 */
async function clearPaperlessKashFlowFields(paperlessId, existingCf) {
  const api = makeClient();
  const id = Number(paperlessId);
  if (!Number.isFinite(id)) throw new Error("paperlessId must be a number");

  const clears = {
    "KashFlow Purchase Id": null,
    "KashFlow Purchase Number": null,
    "KashFlow Purchase Permalink": null,
    "KashFlow Last Send Status": null,
  };

  try {
    const res = await api.updateDocumentCustomFieldsDirect(id, clears, existingCf || []);
    logger.info(`[paperlessUpdate] Cleared KashFlow custom fields for doc ${id} (orphaned purchase)`);
    return { cleared: true, data: res };
  } catch (err) {
    logger.warn(`[paperlessUpdate] Failed to clear KashFlow fields for doc ${id}: ${err.message}`);
    throw err;
  }
}

module.exports = { updatePaperlessWithKashFlowInfo, clearPaperlessKashFlowFields };

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

module.exports.updatePaperlessDocumentTags = updatePaperlessDocumentTags;
