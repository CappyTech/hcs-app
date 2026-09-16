// services/paperless/supplierCorrespondentSyncService.js
//
// Keep Paperless-ngx correspondents in step with KashFlow suppliers.
//
// The Purchase Invoice Capture Process (PICP) requires each invoice's Paperless
// "Corresponder" to closely match the KashFlow Supplier Name. When a new supplier
// is added in KashFlow, whoever files the invoice otherwise has to hand-create the
// correspondent (and any typo breaks the downstream match on send). This service
// mirrors every active KashFlow supplier into Paperless as a correspondent so the
// name is always there to pick, spelled exactly as KashFlow holds it.
//
// One-way, additive and idempotent: it only ever CREATES correspondents that are
// missing. It never renames, never deletes, and never touches correspondents that
// have no matching supplier (Paperless also holds correspondents for customers,
// HMRC, banks, etc. — none of those are ours to prune).

import mdb from '../mongooseDatabaseService.js';
import __paperlessClient from './paperlessClient.js';
const { makeClient } = __paperlessClient;
import logger from '../../../services/loggerService.js';

// Module-level guard: never overlap two sync runs (scheduled + manual, or two ticks)
let syncRunning = false;
function isSyncRunning() { return syncRunning; }

// Normalise a name for case-insensitive, whitespace-tolerant matching.
// Paperless enforces unique correspondent names, so this is only about avoiding
// duplicates that differ by case or padding — we do NOT collapse punctuation, so
// "A & B Ltd" and "A and B Ltd" remain distinct (as they are distinct suppliers).
function normaliseName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure decision: which supplier names need a correspondent created.
 * Deduplicates within the supplier list and skips any that already exist
 * (case/whitespace-insensitive). Returns original-cased names, first spelling wins.
 * @param {string[]} supplierNames
 * @param {Iterable<string>} existingCorrespondentNames
 * @returns {string[]} names to create
 */
function computeMissingCorrespondents(supplierNames, existingCorrespondentNames) {
  const existing = new Set();
  for (const n of existingCorrespondentNames || []) existing.add(normaliseName(n));
  const toCreate = new Map(); // normalised -> original
  for (const raw of supplierNames || []) {
    const original = String(raw || '').trim();
    if (!original) continue;
    const key = normaliseName(original);
    if (existing.has(key) || toCreate.has(key)) continue;
    toCreate.set(key, original);
  }
  return [...toCreate.values()];
}

/**
 * Sync active KashFlow suppliers into Paperless correspondents.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] – log what would be created, create nothing.
 * @returns {Promise<{suppliers:number, existing:number, created:number, skipped:number, failed:number, dryRun:boolean}>}
 */
async function syncSuppliersToCorrespondents(options = {}) {
  if (syncRunning) {
    logger.warn('[correspondentSync] Sync already in progress — skipping concurrent run.');
    return { suppliers: 0, existing: 0, created: 0, skipped: 0, failed: 0, dryRun: false, skippedRun: true };
  }
  syncRunning = true;
  try {
    const dryRun = options.dryRun === true;
    await mdb.connect();
    const Supplier = mdb.REST && mdb.REST.supplier;
    if (!Supplier) throw new Error('Supplier model unavailable (REST namespace not loaded)');

    const api = makeClient();

    // 1. Load active suppliers with a usable name. Archived suppliers are left out:
    //    they should not accrue new invoices, so a fresh correspondent for them is noise.
    const suppliers = await Supplier
      .find({ IsArchived: { $ne: true }, Name: { $nin: [null, ''] } })
      .select('Name')
      .lean();

    // 2. Load every existing correspondent (paginated) into a normalised-name set,
    //    so we can tell in O(1) whether a supplier already has one.
    const existingByName = new Set();
    {
      let page = 1;
      while (true) {
        const chunk = await api.listCorrespondents({ page, pageSize: 100, ordering: 'name' });
        const results = Array.isArray(chunk?.results) ? chunk.results : [];
        for (const c of results) {
          if (c?.name) existingByName.add(normaliseName(c.name));
        }
        if (!chunk?.next || results.length === 0) break;
        page += 1;
      }
    }

    // 3. Determine the unique set of supplier names that are missing a correspondent.
    //    Dedupe within the supplier list too (two suppliers can share a display name).
    const namesToCreate = computeMissingCorrespondents(
      suppliers.map((s) => s.Name),
      existingByName,
    );

    let created = 0, skipped = 0, failed = 0;
    for (const name of namesToCreate) {
      const key = normaliseName(name);
      if (dryRun) {
        logger.info(`[correspondentSync] [dry-run] would create correspondent "${name}"`);
        skipped += 1;
        continue;
      }
      try {
        await api.createCorrespondent({ name });
        existingByName.add(key); // guard against duplicates within this same run
        created += 1;
      } catch (err) {
        // A 400 here is almost always Paperless rejecting a duplicate name that
        // slipped past our set (e.g. created concurrently, or differing only by
        // punctuation Paperless folds). Treat as already-present, not a failure.
        const status = err?.response?.status;
        if (status === 400) {
          existingByName.add(key);
          skipped += 1;
          logger.warn(`[correspondentSync] Correspondent "${name}" rejected as duplicate (400) — treating as existing.`);
        } else {
          failed += 1;
          logger.error(`[correspondentSync] Failed to create correspondent "${name}": ${err.message}`);
        }
      }
    }

    const existing = suppliers.length - namesToCreate.length;
    const summary = {
      suppliers: suppliers.length,
      existing,
      created,
      skipped,
      failed,
      dryRun,
    };
    logger.info(
      `[correspondentSync] Complete. suppliers=${summary.suppliers} existing=${existing} created=${created} skipped=${skipped} failed=${failed}${dryRun ? ' (dry-run)' : ''}`,
    );
    return summary;
  } finally {
    syncRunning = false;
  }
}

export default {
  syncSuppliersToCorrespondents,
  isSyncRunning,
  computeMissingCorrespondents,
  normaliseName,
};
