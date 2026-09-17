// services/dashboardCountService.js
//
// Optional per-tile counts for the department dashboards. A provider returns
// { value, attention, label }:
//   - value:     an ambient number shown inline on the tile (e.g. "42 active")
//   - attention: a number that, when > 0, promotes the tile from a compact row
//                to a highlighted card (e.g. pending approvals). 0 = calm.
//   - label:     word after the attention number ("pending", "unlinked").
//
// Everything here is best-effort: results are cached briefly, each provider is
// time-boxed, and any failure yields no count (the tile just renders plain) so
// a slow or broken query can never break or noticeably delay a hub load.

import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

const TTL_MS = parseInt(process.env.DASHBOARD_COUNT_TTL_MS, 10) || 60_000;
const PROVIDER_TIMEOUT_MS = parseInt(process.env.DASHBOARD_COUNT_TIMEOUT_MS, 10) || 2_000;

const _cache = new Map(); // tileKey -> { at, val }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('count timed out')), ms)),
  ]);
}

// Registry of count providers keyed by tile key. Only providers whose tile is on
// the page are ever run. Each is an async () => ({ value?, attention?, label? }).
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
  // Ambient counts (no attention) — just context on the row.
  employee: async () => {
    const M = mdb.INTERNAL?.employee;
    if (!M) return null;
    return { value: await M.countDocuments({}), attention: 0 };
  },
  supplier: async () => {
    const M = mdb.REST?.supplier;
    if (!M) return null;
    return { value: await M.countDocuments({ IsArchived: { $ne: true } }), attention: 0 };
  },
  vehicle: async () => {
    const M = mdb.INTERNAL?.vehicle;
    if (!M) return null;
    return { value: await M.countDocuments({}), attention: 0 };
  },
};

async function one(tileKey) {
  const cached = _cache.get(tileKey);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.val;
  try {
    const val = await withTimeout(providers[tileKey](), PROVIDER_TIMEOUT_MS);
    _cache.set(tileKey, { at: Date.now(), val });
    return val;
  } catch (e) {
    logger.warn(`[dashboardCount] ${tileKey} failed: ${e.message}`);
    return null;
  }
}

/**
 * Resolve counts for the given tile keys. Returns a Map<tileKey, {value,attention,label}>
 * containing only keys that have a provider and produced a non-null result.
 */
async function getCountsFor(tileKeys = []) {
  const wanted = [...new Set(tileKeys)].filter((k) => providers[k]);
  const out = new Map();
  if (wanted.length === 0) return out;
  const results = await Promise.allSettled(wanted.map((k) => one(k)));
  wanted.forEach((k, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) out.set(k, r.value);
  });
  return out;
}

export default { getCountsFor, providers };
