// services/dashboardCountService.js
//
// Optional per-tile counts for the department dashboards. A count is
// { value, attention, label }:
//   - value:     an ambient number shown inline on the tile (e.g. "1,203")
//   - attention: a number that, when > 0, promotes the tile from a compact row
//                to a highlighted card (e.g. pending approvals). 0 = calm.
//   - label:     word after the number ("pending", "unlinked"); omitted for
//                plain totals.
//
// Every model-backed tile gets an ambient total for free (estimatedDocumentCount
// — O(1) collection metadata), so counts are consistent across a hub. A few tiles
// have a bespoke provider that surfaces an actionable number instead.
//
// Everything here is best-effort: results are cached briefly, each lookup is
// time-boxed, and any failure yields no count (the tile just renders plain) so a
// slow or broken query can never break or noticeably delay a hub load.

import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

const TTL_MS = parseInt(process.env.DASHBOARD_COUNT_TTL_MS, 10) || 60_000;
const LOOKUP_TIMEOUT_MS = parseInt(process.env.DASHBOARD_COUNT_TIMEOUT_MS, 10) || 2_000;
const NAMESPACES = ['REST', 'INTERNAL', 'PAPERLESS', 'WEB'];

const _cache = new Map(); // tileKey -> { at, val }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('count timed out')), ms)),
  ]);
}

// Resolve a mongoose model by name across the namespaces, exact first then
// case-insensitively (listConfig keys like "vatrate" can differ in case from the
// registered model name).
function resolveModel(modelName) {
  if (!modelName) return null;
  for (const ns of NAMESPACES) {
    const m = mdb[ns]?.[modelName];
    if (m && typeof m.estimatedDocumentCount === 'function') return m;
  }
  const lower = String(modelName).toLowerCase();
  for (const ns of NAMESPACES) {
    const bag = mdb[ns];
    if (!bag) continue;
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === lower && typeof bag[key]?.estimatedDocumentCount === 'function') {
        return bag[key];
      }
    }
  }
  return null;
}

// Bespoke providers keyed by tile key — an actionable number in place of a total.
const providers = {
  // HR / Management — holiday requests awaiting a decision.
  holidayRequest: async () => {
    const M = mdb.INTERNAL?.holidayRequest;
    if (!M) return null;
    const pending = await M.countDocuments({ status: 'pending' });
    return { value: pending, attention: pending, label: 'pending' };
  },
  // Documents — OCR docs not yet linked to a KashFlow purchase.
  OcrDocument: async () => {
    const M = mdb.PAPERLESS?.OcrDocument;
    if (!M) return null;
    const unlinked = await M.countDocuments({ kashflowPurchaseId: null, deletedInPaperlessAt: null });
    return { value: unlinked, attention: unlinked, label: 'unlinked' };
  },
};

async function compute(tile) {
  const provider = providers[tile.tileKey];
  if (provider) return provider();
  if (tile.model) {
    const M = resolveModel(tile.model);
    if (M) return { value: await M.estimatedDocumentCount(), attention: 0 };
  }
  return null;
}

async function one(tile) {
  const cached = _cache.get(tile.tileKey);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.val;
  try {
    const val = await withTimeout(compute(tile), LOOKUP_TIMEOUT_MS);
    _cache.set(tile.tileKey, { at: Date.now(), val });
    return val;
  } catch (e) {
    logger.warn(`[dashboardCount] ${tile.tileKey} failed: ${e.message}`);
    return null;
  }
}

/**
 * Resolve counts for the given tiles. `tiles` is an array of { tileKey, model? };
 * model-backed tiles get an ambient total, a few keys get a bespoke count, and
 * everything else gets nothing. Returns Map<tileKey, {value,attention,label}>.
 */
async function getCountsFor(tiles = []) {
  const wanted = tiles.filter((t) => providers[t.tileKey] || t.model);
  const out = new Map();
  if (wanted.length === 0) return out;
  const results = await Promise.allSettled(wanted.map((t) => one(t)));
  wanted.forEach((t, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) out.set(t.tileKey, r.value);
  });
  return out;
}

export default { getCountsFor, providers };
