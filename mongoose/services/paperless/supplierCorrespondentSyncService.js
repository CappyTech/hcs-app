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
// A supplier's correspondent is named "<Name> (<Code>)" (correspondentName.js),
// so Paperless shows at a glance which correspondents come from KashFlow and
// which were made by hand, and hcs-app finds the supplier by its code.
//
// One-way and idempotent. Every run creates missing correspondents and keeps
// coded ones in step with a supplier renamed in KashFlow. Renaming a hand-made
// correspondent that matches a supplier ("Beers" → "Beers LTD (BEE01)") only
// happens when asked for (`renameMatched`), after a dry run has been checked:
// scripts/paperless-correspondent-codes.js. It never deletes, and never touches
// correspondents with no matching supplier (Paperless also holds correspondents
// for customers, HMRC, banks, etc. — none of those are ours).

import mdb from '../mongooseDatabaseService.js';
import __paperlessClient from './paperlessClient.js';
const { makeClient } = __paperlessClient;
import logger from '../../../services/loggerService.js';
import { correspondentLabel, parseCorrespondentName } from './correspondentName.js';

// Paperless MatchingModel algorithm for new correspondents: 6 = Auto, so each
// synced supplier's correspondent learns from the invoices filed against it and
// is auto-assigned to future documents (Paperless's own default is Any with an
// empty match, which never auto-assigns).
const MATCH_AUTO = 6;

// Module-level guard: never overlap two sync runs (scheduled + manual, or two ticks)
let syncRunning = false;
function isSyncRunning() { return syncRunning; }

// Normalise a name for case-insensitive, whitespace-tolerant matching.
// This is the exact key: same name modulo case and padding.
function normaliseName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Canonical key for duplicate *avoidance*. Deliberately more aggressive than
// normaliseName, and used ONLY to answer "does an equivalent correspondent
// already exist?" — never to rename or delete anything.
//
// Why this exists: KashFlow stores supplier names with their legal suffix
// ("Beers LTD", "Titan Land and Building Ltd"), while the correspondents already
// in Paperless were typed by whoever filed the first invoice, usually without it
// ("Beers", "Titan Land & Building"). Exact matching missed those, so every such
// supplier spawned a twin correspondent with 0 documents. Folding the legal
// suffix, a leading "The", & vs and, and punctuation/spacing makes the supplier
// match its existing correspondent instead of creating a duplicate.
//
// Scope is kept tight on purpose: only unambiguous company forms
// (ltd/limited/llp/plc/inc) and a leading article are stripped — NOT words like
// "services", "group" or "co" — so two genuinely different suppliers are very
// unlikely to collapse onto one key. The trade-off (a near-identical brand-new
// supplier reuses an existing correspondent rather than getting its own) is the
// safe direction: PICP needs a close name match anyway, and no data is lost.
function canonicalName(name) {
  let t = ' ' + String(name || '').toLowerCase().trim() + ' ';
  t = t.replace(/&/g, ' and ');
  t = t.replace(/[^a-z0-9 ]/g, ' ');            // punctuation -> space
  t = t.replace(/\b(ltd|limited|llp|plc|inc)\b/g, ' '); // legal suffix
  t = t.replace(/^\s*the\s+/, ' ');             // leading article
  return t.replace(/\s+/g, ' ').trim();
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
  const existing = new Set();       // exact normalised keys
  const existingCanon = new Set();  // canonical (suffix/punctuation-folded) keys
  for (const n of existingCorrespondentNames || []) {
    existing.add(normaliseName(n));
    const c = canonicalName(n);
    if (c) existingCanon.add(c);
  }
  const toCreate = new Map(); // canonical (or exact) key -> original
  for (const raw of supplierNames || []) {
    const original = String(raw || '').trim();
    if (!original) continue;
    const key = normaliseName(original);
    const canon = canonicalName(original);
    // Skip if an equivalent correspondent already exists — exact first, then the
    // canonical match that stops KashFlow's "… LTD" spelling from twinning an
    // existing suffix-less correspondent — or if we've already queued an
    // equivalent name this run.
    if (existing.has(key)) continue;
    if (canon && existingCanon.has(canon)) continue;
    const dedupeKey = canon || key;
    if (toCreate.has(dedupeKey)) continue;
    toCreate.set(dedupeKey, original);
  }
  return [...toCreate.values()];
}

/**
 * Pure decision: what each active supplier's correspondent needs.
 *
 *   coded     a correspondent already carries the supplier's code: rename it
 *             only if the name has changed in KashFlow
 *   matched   a hand-made correspondent has the supplier's name (exactly, or
 *             as canonicalName folds it): renamed to "<Name> (<Code>)" when
 *             `renameMatched`, otherwise left alone
 *   missing   nothing matches: create "<Name> (<Code>)"
 *
 * A hand-made correspondent that two suppliers would both claim is left alone
 * and reported as ambiguous. A supplier with no code keeps its plain name.
 *
 * @param {Array<{Name, Code}>} suppliers
 * @param {Array<{id, name}>} correspondents
 * @returns {{create: string[], rename: Array<{id, from, to, why: 'kashflow'|'matched'}>, matched: Array<{id, name, to}>, ambiguous: Array<{id, name, codes: string[]}>, inStep: number}}
 */
function planCorrespondents(suppliers, correspondents, { renameMatched = false } = {}) {
  const byCode = new Map();
  const uncoded = [];
  const exactKeys = new Set();
  for (const c of correspondents || []) {
    if (!c?.name) continue;
    exactKeys.add(normaliseName(c.name));
    const { code } = parseCorrespondentName(c.name);
    if (code) byCode.set(code.toLowerCase(), c);
    else uncoded.push(c);
  }
  // Which suppliers each hand-made correspondent could stand for
  const claims = new Map(); // correspondent id → supplier codes
  const candidatesFor = (s) => {
    const key = normaliseName(s.Name);
    const canon = canonicalName(s.Name);
    const exact = uncoded.filter((c) => normaliseName(c.name) === key);
    return exact.length ? exact : uncoded.filter((c) => canon && canonicalName(c.name) === canon);
  };
  const active = (suppliers || []).filter((s) => String(s?.Name || '').trim());
  for (const s of active) {
    if (!s.Code || byCode.has(String(s.Code).toLowerCase())) continue;
    for (const c of candidatesFor(s)) claims.set(c.id, [...(claims.get(c.id) || []), s.Code]);
  }

  const plan = { create: [], rename: [], matched: [], ambiguous: [], inStep: 0 };
  const queued = new Set();
  const seenAmbiguous = new Set();
  for (const s of active) {
    const label = correspondentLabel(s);
    if (!s.Code) {
      // No code to carry: the plain-name behaviour from before codes
      const missing = computeMissingCorrespondents([s.Name], [...exactKeys, ...queued]);
      if (missing.length) { plan.create.push(missing[0]); queued.add(normaliseName(missing[0])); }
      else plan.inStep += 1;
      continue;
    }
    const coded = byCode.get(String(s.Code).toLowerCase());
    if (coded) {
      if (coded.name !== label) plan.rename.push({ id: coded.id, from: coded.name, to: label, why: 'kashflow' });
      else plan.inStep += 1;
      continue;
    }
    const candidates = candidatesFor(s);
    const mine = candidates.filter((c) => (claims.get(c.id) || []).length === 1);
    if (candidates.length && !mine.length) {
      for (const c of candidates) {
        if (seenAmbiguous.has(c.id)) continue;
        seenAmbiguous.add(c.id);
        plan.ambiguous.push({ id: c.id, name: c.name, codes: claims.get(c.id) || [] });
      }
      continue;
    }
    if (mine.length) {
      const c = mine[0];
      if (renameMatched) plan.rename.push({ id: c.id, from: c.name, to: label, why: 'matched' });
      else plan.matched.push({ id: c.id, name: c.name, to: label });
      continue;
    }
    if (!queued.has(normaliseName(label))) { plan.create.push(label); queued.add(normaliseName(label)); }
  }
  return plan;
}

/**
 * Sync active KashFlow suppliers into Paperless correspondents.
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] – work out the plan, change nothing.
 * @param {boolean} [options.renameMatched=false] – also rename hand-made correspondents that match a supplier.
 * @returns {Promise<{suppliers, existing, created, renamed, matched, ambiguous, skipped, failed, dryRun, plan}>}
 */
async function syncSuppliersToCorrespondents(options = {}) {
  if (syncRunning) {
    logger.warn('[correspondentSync] Sync already in progress — skipping concurrent run.');
    return { suppliers: 0, existing: 0, created: 0, renamed: 0, matched: 0, ambiguous: 0, skipped: 0, failed: 0, dryRun: false, skippedRun: true };
  }
  syncRunning = true;
  try {
    const dryRun = options.dryRun === true;
    const renameMatched = options.renameMatched === true;
    await mdb.connect();
    const Supplier = mdb.REST && mdb.REST.supplier;
    if (!Supplier) throw new Error('Supplier model unavailable (REST namespace not loaded)');

    const api = options.api || makeClient();

    // 1. Active suppliers with a usable name. Archived suppliers are left out:
    //    they should not accrue new invoices, so a fresh correspondent for them is noise.
    const suppliers = await Supplier
      .find({ IsArchived: { $ne: true }, Name: { $nin: [null, ''] } })
      .select('Name Code')
      .lean();

    // 2. Every existing correspondent (paginated), with its id for renames
    const correspondents = [];
    for (let page = 1; ; page += 1) {
      const chunk = await api.listCorrespondents({ page, pageSize: 100, ordering: 'name' });
      const results = Array.isArray(chunk?.results) ? chunk.results : [];
      for (const c of results) if (c?.name) correspondents.push({ id: c.id, name: c.name });
      if (!chunk?.next || results.length === 0) break;
    }

    const plan = planCorrespondents(suppliers, correspondents, { renameMatched });

    let created = 0, renamed = 0, skipped = 0, failed = 0;
    if (dryRun) {
      for (const name of plan.create) logger.info(`[correspondentSync] [dry-run] would create "${name}"`);
      for (const r of plan.rename) logger.info(`[correspondentSync] [dry-run] would rename "${r.from}" → "${r.to}"`);
      skipped = plan.create.length + plan.rename.length;
    } else {
      for (const name of plan.create) {
        try {
          await api.createCorrespondent({ name, matchingAlgorithm: MATCH_AUTO });
          created += 1;
        } catch (err) {
          // A 400 here is almost always Paperless rejecting a duplicate name
          // (created concurrently, or differing only by punctuation Paperless
          // folds). Treat as already-present, not a failure.
          if (err?.response?.status === 400) {
            skipped += 1;
            logger.warn(`[correspondentSync] Correspondent "${name}" rejected as duplicate (400) — treating as existing.`);
          } else {
            failed += 1;
            logger.error(`[correspondentSync] Failed to create correspondent "${name}": ${err.message}`);
          }
        }
      }
      for (const r of plan.rename) {
        try {
          await api.updateCorrespondent(r.id, { name: r.to });
          renamed += 1;
        } catch (err) {
          failed += 1;
          logger.error(`[correspondentSync] Failed to rename "${r.from}" → "${r.to}": ${err.message}`);
        }
      }
    }

    const summary = {
      suppliers: suppliers.length,
      existing: plan.inStep + plan.matched.length,
      created,
      renamed,
      matched: plan.matched.length,
      ambiguous: plan.ambiguous.length,
      skipped,
      failed,
      dryRun,
      plan,
    };
    logger.info(
      `[correspondentSync] Complete. suppliers=${summary.suppliers} existing=${summary.existing} created=${created} renamed=${renamed} matched-not-renamed=${summary.matched} ambiguous=${summary.ambiguous} skipped=${skipped} failed=${failed}${dryRun ? ' (dry-run)' : ''}`,
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
  planCorrespondents,
  normaliseName,
  canonicalName,
};
