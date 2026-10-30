/**
 * mailRuleService.js — the Paperless mail rules hcs-app depends on, read live.
 *
 * Paperless files incoming email by mail rule: each rule matches a To address
 * and assigns a document type and a tag. hcs-app never sees the addresses; it
 * picks documents up by type id and tag id. So a rule turned off or pointed at
 * another type in Paperless means hcs-app silently gets nothing, and staff
 * have nowhere in the app to look up where to send things.
 *
 * Paperless stays the single owner of the addresses — nothing here is a
 * setting. This reads the rules and turns them into:
 *   - a "where to send it" guide, one line per document type;
 *   - warnings for a type or tag hcs-app relies on that no enabled rule
 *     assigns, a disabled rule, and a rule pointing at a type or tag id that
 *     no longer exists;
 *   - a dated history: each read is compared with the last saved snapshot and
 *     a MailRuleSnapshot row is saved only when a rule's address, type, tags,
 *     scope, attachment filter or enabled flag changed.
 *
 * Reads are cached for PAPERLESS_MAIL_RULES_CACHE_MS (default 5 minutes). When
 * Paperless can't be reached the guide falls back to the last saved snapshot.
 */

import mdb from '../mongooseDatabaseService.js';
import __paperlessClient from './paperlessClient.js';
import logger from '../../../services/loggerService.js';
import { PAPERLESS_DOCUMENT_TYPES } from '../../config/paperlessTypesConfig.js';
import { PAPERLESS_TAGS } from '../../config/paperlessTagsConfig.js';

const { makeClient } = __paperlessClient;

/** The document types hcs-app picks up, in guide order, with staff wording. */
export const HANDLED_TYPES = [
  { key: 'purchaseInvoice', label: 'Purchase invoices' },
  { key: 'subcontractorInvoice', label: 'Subcontractor invoices' },
  { key: 'supplierStatement', label: 'Supplier statements' },
  { key: 'bankStatement', label: 'Bank statements' },
];

/** Tags hcs-app finds documents by (bankStatementIngestService filters on this one). */
export const HANDLED_TAGS = [
  { key: 'bankStatement', label: 'Bank statements', usedBy: 'bank statement reading' },
];

/** Paperless MailRule.consumption_scope. */
export const SCOPE = { ATTACHMENTS: 1, EMAIL: 2, BOTH: 3 };

const MINUTE = 60 * 1000;
const cacheTtl = () => Number.parseInt(process.env.PAPERLESS_MAIL_RULES_CACHE_MS, 10) || 5 * MINUTE;
const FAILURE_TTL_MS = MINUTE;

// ── Reading ─────────────────────────────────────────────────────────────

async function listAllTags(api) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await api.listTags({ page, pageSize: 100 });
    out.push(...(data?.results || []));
    if (!data?.next) break;
  }
  return out;
}

/** Everything needed from Paperless, in one go. Throws if Paperless can't be reached. */
export async function readLive(api) {
  const [rules, accounts, documentTypes, tags] = await Promise.all([
    api.listMailRules(),
    api.listMailAccounts(),
    api.listDocumentTypes(),
    listAllTags(api),
  ]);
  return { rules, accounts, documentTypes, tags };
}

/**
 * The config of each rule, with type and tag names resolved. A name left null
 * means the rule points at an id Paperless no longer has. This is also the
 * shape saved in MailRuleSnapshot, so the guide can be rebuilt from a snapshot.
 */
export function normaliseRules({ rules = [], accounts = [], documentTypes = [], tags = [] }) {
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const typeName = new Map(documentTypes.map((t) => [t.id, t.name]));
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  return rules.map((r) => {
    const tagIds = (Array.isArray(r.assign_tags) ? r.assign_tags : []).map(Number).sort((a, b) => a - b);
    const documentTypeId = r.assign_document_type == null ? null : Number(r.assign_document_type);
    return {
      ruleId: r.id,
      name: r.name || `Rule ${r.id}`,
      account: accountName.get(r.account) ?? null,
      to: String(r.filter_to || '').trim() || null,
      documentTypeId,
      documentType: documentTypeId == null ? null : typeName.get(documentTypeId) ?? null,
      tagIds,
      tags: tagIds.map((id) => tagName.get(id) ?? null),
      scope: Number(r.consumption_scope) || SCOPE.ATTACHMENTS,
      attachmentFilter: String(r.filter_attachment_filename_include || '').trim() || null,
      enabled: r.enabled !== false,
    };
  });
}

// ── Guide and warnings ──────────────────────────────────────────────────

/** "PDF attachments", "the email body", or both, from the rule's scope and filter. */
export function describeAccepts(rule) {
  const f = rule.attachmentFilter;
  const attachments = !f ? 'attachments'
    : /^\*?\.pdf$/i.test(f) ? 'PDF attachments'
    : `attachments named ${f}`;
  if (rule.scope === SCOPE.EMAIL) return 'the email body';
  if (rule.scope === SCOPE.BOTH) return `${attachments} or the email body`;
  return `${attachments} only`;
}

/** "bank@" for an address, else the rule's name: how a rule is named in warnings and history. */
export function ruleLabel(rule) {
  const local = String(rule.to || '').split('@')[0];
  return rule.to && rule.to.includes('@') && local ? `${local}@ rule` : `"${rule.name}" rule`;
}

const typeEntry = (key) => PAPERLESS_DOCUMENT_TYPES[key];
const tagEntry = (key) => PAPERLESS_TAGS[key];

/**
 * The guide lines and warnings for a set of normalised rules.
 * @returns {{ lines: Array, warnings: Array }}
 */
export function buildGuide(rules) {
  const enabled = rules.filter((r) => r.enabled);
  const lines = [];
  const placed = new Set();

  const address = (r) => ({ ruleId: r.ruleId, to: r.to, accepts: describeAccepts(r), ruleName: r.name });

  for (const { key, label } of HANDLED_TYPES) {
    const type = typeEntry(key);
    const matching = enabled.filter((r) => r.documentTypeId === type.id
      // The bank reader goes by tag, so a rule tagging bank statements counts too
      || (key === 'bankStatement' && r.tagIds.includes(tagEntry('bankStatement').id)));
    matching.forEach((r) => placed.add(r.ruleId));
    lines.push({ key, label, handled: true, addresses: matching.map(address) });
  }
  // Other enabled rules (remittance advice, say): shown so staff see the whole picture
  const others = new Map();
  for (const r of enabled) {
    if (placed.has(r.ruleId)) continue;
    const groupKey = r.documentTypeId != null ? `type:${r.documentTypeId}` : `rule:${r.ruleId}`;
    if (!others.has(groupKey)) {
      others.set(groupKey, { key: groupKey, label: r.documentType || r.name, handled: false, addresses: [] });
    }
    others.get(groupKey).addresses.push(address(r));
  }
  lines.push(...others.values());

  const warnings = [];
  for (const { key, label } of HANDLED_TYPES) {
    const type = typeEntry(key);
    if (!enabled.some((r) => r.documentTypeId === type.id)) {
      warnings.push({
        code: 'type_unassigned', level: 'error',
        message: `No enabled mail rule files emails as document type ${type.id} (${label.toLowerCase()}), so emailed ${label.toLowerCase()} won't reach hcs-app.`,
      });
    }
  }
  for (const { key, label, usedBy } of HANDLED_TAGS) {
    const tag = tagEntry(key);
    if (!enabled.some((r) => r.tagIds.includes(tag.id))) {
      warnings.push({
        code: 'tag_unassigned', level: 'error',
        message: `No enabled mail rule adds tag ${tag.id} (${tag.names[0]}), which ${usedBy} looks for, so emailed ${label.toLowerCase()} won't be read.`,
      });
    }
  }
  for (const r of rules) {
    if (!r.enabled) {
      warnings.push({ code: 'rule_disabled', level: 'warning', ruleId: r.ruleId, message: `The ${ruleLabel(r)} ("${r.name}") is disabled in Paperless, so emails to ${r.to || 'it'} are not being filed.` });
    }
    if (r.documentTypeId != null && r.documentType == null) {
      warnings.push({ code: 'unknown_type', level: 'error', ruleId: r.ruleId, message: `The ${ruleLabel(r)} assigns document type ${r.documentTypeId}, which no longer exists in Paperless.` });
    }
    r.tagIds.forEach((id, i) => {
      if (r.tags[i] == null) {
        warnings.push({ code: 'unknown_tag', level: 'error', ruleId: r.ruleId, message: `The ${ruleLabel(r)} assigns tag ${id}, which no longer exists in Paperless.` });
      }
    });
  }
  return { lines, warnings };
}

/** The addresses that bank statements should be sent to, from a guide. */
export function bankStatementAddresses(guide) {
  return (guide?.lines || []).find((l) => l.key === 'bankStatement')?.addresses.map((a) => a.to).filter(Boolean) || [];
}

// ── Change history ──────────────────────────────────────────────────────

const SCOPE_LABEL = { 1: 'attachments only', 2: 'the email body only', 3: 'attachments and the email body' };
const typeText = (r) => (r.documentType ? r.documentType : r.documentTypeId == null ? 'no type' : `type ${r.documentTypeId}`);
const tagsText = (r) => (r.tagIds.length ? r.tagIds.map((id, i) => r.tags[i] || `tag ${id}`).join(', ') : 'no tags');

/** The changes from one set of normalised rules to the next, with a one-line summary each. */
export function diffRules(prev, next) {
  const before = new Map(prev.map((r) => [r.ruleId, r]));
  const after = new Map(next.map((r) => [r.ruleId, r]));
  const changes = [];

  for (const r of next) {
    const p = before.get(r.ruleId);
    if (!p) {
      changes.push({ ruleId: r.ruleId, kind: 'added', summary: `New ${ruleLabel(r)} ("${r.name}"): ${r.to || 'any address'} files as ${typeText(r)}${r.enabled ? '' : ' (disabled)'}` });
      continue;
    }
    const was = ruleLabel(p);
    const change = (field, from, to, summary) => changes.push({ ruleId: r.ruleId, kind: 'changed', field, from, to, summary });
    if (p.enabled !== r.enabled) change('enabled', p.enabled, r.enabled, `${was} ${r.enabled ? 'enabled' : 'disabled'}`);
    if (p.to !== r.to) change('to', p.to, r.to, `${was} now matches ${r.to || 'any address'} (was ${p.to || 'any address'})`);
    if (p.documentTypeId !== r.documentTypeId) change('documentType', typeText(p), typeText(r), `${was} now files as ${typeText(r)} (was ${typeText(p)})`);
    if (p.tagIds.join(',') !== r.tagIds.join(',')) change('tags', tagsText(p), tagsText(r), `${was} now tags ${tagsText(r)} (was ${tagsText(p)})`);
    if (p.scope !== r.scope) change('scope', SCOPE_LABEL[p.scope] || p.scope, SCOPE_LABEL[r.scope] || r.scope, `${was} now takes ${SCOPE_LABEL[r.scope] || `scope ${r.scope}`} (was ${SCOPE_LABEL[p.scope] || `scope ${p.scope}`})`);
    if (p.attachmentFilter !== r.attachmentFilter) change('attachmentFilter', p.attachmentFilter, r.attachmentFilter, `${was} now accepts ${describeAccepts(r)} (was ${describeAccepts(p)})`);
  }
  for (const p of prev) {
    if (!after.has(p.ruleId)) changes.push({ ruleId: p.ruleId, kind: 'removed', summary: `${ruleLabel(p)} ("${p.name}") removed` });
  }
  return changes;
}

async function latestSnapshot(Model) {
  const [row] = await Model.find({}).sort({ takenAt: -1 }).limit(1).lean();
  return row || null;
}

/**
 * Save the rules if they differ from the last snapshot (or there is none).
 * @returns {Promise<{ baseline: boolean, changes: Array, saved: boolean }>}
 */
export async function recordSnapshot(Model, rules, { now = new Date() } = {}) {
  const last = await latestSnapshot(Model);
  if (!last) {
    await Model.create({ takenAt: now, baseline: true, rules, changes: [] });
    return { baseline: true, changes: [], saved: true };
  }
  const changes = diffRules(last.rules || [], rules);
  if (!changes.length) return { baseline: false, changes, saved: false };
  await Model.create({ takenAt: now, baseline: false, rules, changes });
  return { baseline: false, changes, saved: true };
}

/** Dated history, newest first: the first snapshot, then every change. */
export async function loadHistory(Model, { limit = 50 } = {}) {
  const rows = await Model.find({}).sort({ takenAt: -1 }).limit(limit).lean();
  return rows.map((r) => ({
    takenAt: r.takenAt,
    baseline: Boolean(r.baseline),
    changes: r.baseline ? [] : r.changes || [],
    ruleCount: (r.rules || []).length,
  }));
}

// ── Cached overview ─────────────────────────────────────────────────────

let cache = null;    // { at, ttl, value }
let inflight = null;

export function invalidateMailRulesCache() {
  cache = null;
}

/**
 * Read the rules from Paperless, record any change, and build the guide.
 * Never throws: when Paperless can't be reached it returns `live: false`
 * with the guide rebuilt from the last saved snapshot, if there is one.
 */
export async function loadOverview({ api = null, Model = null, now = new Date() } = {}) {
  try {
    const rules = normaliseRules(await readLive(api || makeClient()));
    let recorded = null;
    if (Model) {
      try {
        recorded = await recordSnapshot(Model, rules, { now });
      } catch (err) {
        logger.warn(`[mailRules] could not save the snapshot: ${err.message}`);
      }
    }
    return { live: true, checkedAt: now, rules, ...buildGuide(rules), recorded };
  } catch (err) {
    logger.warn(`[mailRules] Paperless mail rules unavailable: ${err.message}`);
    let last = null;
    try { last = Model ? await latestSnapshot(Model) : null; } catch { /* the database may be down too */ }
    const rules = last?.rules || [];
    return {
      live: false,
      error: err.message,
      checkedAt: now,
      seenAt: last?.takenAt || null,
      rules,
      ...(last ? buildGuide(rules) : { lines: [], warnings: [] }),
      recorded: null,
    };
  }
}

async function snapshotModel() {
  await mdb.connect();
  return mdb.PAPERLESS?.MailRuleSnapshot || null;
}

/** The overview for a page view: served from the cache, re-read when it has expired. */
export async function getOverview({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < cache.ttl) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const Model = await snapshotModel().catch(() => null);
    const value = await loadOverview({ Model });
    cache = { at: Date.now(), ttl: value.live ? cacheTtl() : FAILURE_TTL_MS, value };
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** The paperless-mail-rules job: read now, record any change, refresh the cache. */
export async function runSnapshotJob() {
  const value = await getOverview({ force: true });
  if (!value.live) throw new Error(`Paperless mail rules unavailable: ${value.error}`);
  return {
    rules: value.rules.length,
    warnings: value.warnings.length,
    changes: value.recorded?.changes.length || 0,
    baseline: Boolean(value.recorded?.baseline),
  };
}

export default {
  HANDLED_TYPES,
  HANDLED_TAGS,
  SCOPE,
  readLive,
  normaliseRules,
  describeAccepts,
  ruleLabel,
  buildGuide,
  bankStatementAddresses,
  diffRules,
  recordSnapshot,
  loadHistory,
  loadOverview,
  getOverview,
  invalidateMailRulesCache,
  runSnapshotJob,
};
