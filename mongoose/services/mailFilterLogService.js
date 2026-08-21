/**
 * Inbound mail filtering decisions, read from the mailsiem collector.
 *
 * Context: inbound mail to heroncs.co.uk was being silently rejected by the
 * SpamExperts/StrikeMail filter (Quarantine response set to Rejected, so
 * legitimate senders got a 550 and we never saw it). The mailsiem collector on
 * the host receives a syslog line per filtering decision and writes one NDJSON
 * file per day. This service is hcs-app's read-only window onto those files, so
 * "did my email reach you?" is answerable from the platform rather than from a
 * support ticket.
 *
 * WHY FILES AND NOT MONGO — do not "improve" this by ingesting into a
 * collection. These records are third-party personal data (who emails this
 * business, and who they email) held under a 90-day retention rule enforced by
 * a deletion job on the host. Mongo is dumped nightly by mongo-backup.sh with
 * its own 90-day archive retention, and those archives are browsable at
 * files.heroncs.co.uk — so ingesting would leave copies alive for up to ~180
 * days against a 90-day policy, and the retention job could no longer be the
 * single thing that makes the policy true. Reading the files keeps the
 * collector the sole owner of the data: when a day file is deleted, it is gone
 * everywhere, including here.
 *
 * Consequences of that choice, all deliberate:
 *  - There is no index. Every query is a bounded scan, so the window is capped
 *    (MAX_DAYS) and every entry point takes an explicit day count.
 *  - Lines are filtered as raw text BEFORE JSON.parse. Parsing every line of a
 *    90-day window to discard almost all of it is the whole cost of the query;
 *    a substring test on the raw line is roughly free by comparison.
 *  - Nothing here writes, and there is no write path to add one to. The module
 *    is read-only by absence, the same enforcement style as the missing
 *    KashFlow wrappers in hcs-sync.
 *
 * The directory is a read-only bind mount supplied by docker-compose. If it is
 * absent — which it will be until the collector is deployed alongside the app —
 * every function here degrades to an empty, explicitly "not mounted" result
 * rather than throwing, so the page renders and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Matches the collector's 90-day retention: older files do not exist. */
export const MAX_DAYS = 90;
export const DEFAULT_SEARCH_DAYS = 30;
/** Summary is rendered on every page load, so its default window is narrower. */
export const DEFAULT_SUMMARY_DAYS = 7;
export const MAX_LIMIT = 500;
export const MAX_QUERY_LENGTH = 200;

/**
 * A scan can never run unbounded: a corrupt or unexpectedly enormous day file
 * would otherwise hold a request open indefinitely. On hitting this the result
 * is flagged truncated rather than silently short.
 */
const MAX_LINES_PER_REQUEST = 2_000_000;

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

/** Read at call time, not import time, so tests and compose can both set it. */
export function eventsDir() {
  return process.env.MAILSIEM_EVENTS_DIR || '/app/mailsiem/events';
}

/**
 * A decision that stopped the mail. SpamExperts uses several words for it
 * depending on product and template, and the exact vocabulary is not pinned
 * until the cluster is live, so this matches the family rather than a list of
 * literals. Kept in one place because the summary counters and the
 * "blocked only" filter must agree.
 */
export function isBlocked(status) {
  return /reject|block|quarantin|defer|discard/i.test(String(status || ''));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function normaliseDays(value, fallback = DEFAULT_SEARCH_DAYS) {
  return clampInt(value, fallback, 1, MAX_DAYS);
}

export function normaliseQuery(value) {
  return String(value || '').trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * The day files covering the last `days` days, newest first. Derived from the
 * requested dates rather than by listing the directory, so a narrow window
 * never pays for a wide one; files that do not exist (quiet days, or days
 * already retired by the retention job) are simply skipped.
 */
export function dayFiles(days, now = new Date()) {
  const dir = eventsDir();
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now.getTime() - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const file = path.join(dir, `${date}.ndjson`);
    if (fs.existsSync(file)) out.push({ date, file });
  }
  return out;
}

/**
 * Whether the collector's output is actually mounted, and what it holds.
 * Rendered as a banner: an empty result means something very different when
 * the mount is missing than when the filter simply had a quiet week.
 */
export function status() {
  const dir = eventsDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { mounted: false, dir, files: 0, bytes: 0, oldest: null, newest: null };
  }
  const dates = entries
    .map((name) => FILE_RE.exec(name))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  let bytes = 0;
  for (const date of dates) {
    try {
      bytes += fs.statSync(path.join(dir, `${date}.ndjson`)).size;
    } catch {
      // A file retired by the retention job between readdir and stat is normal.
    }
  }
  return {
    mounted: true,
    dir,
    files: dates.length,
    bytes,
    oldest: dates[0] || null,
    newest: dates[dates.length - 1] || null,
  };
}

/**
 * Stream one day file, handing each line that survives the raw-text filter to
 * `onRow` as a parsed object. Returns the number of lines read.
 *
 * `onRow` returning false stops the scan for that file — that is how the result
 * limit avoids reading the remainder of a large day.
 */
async function scanFile(file, rawFilter, onRow) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return 0;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  try {
    for await (const line of rl) {
      if (!line) continue;
      lines += 1;
      if (rawFilter && !rawFilter(line)) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        // A torn final line (the collector was mid-write) is not an error worth
        // failing a page over; the collector's own health job watches for real
        // parse trouble.
        continue;
      }
      if (onRow(row) === false) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return lines;
}

/**
 * Find filtering decisions. `q` is matched as a case-insensitive substring of
 * the whole raw JSON line, so one box searches sender, recipient, sending IP,
 * message-id and the filtering id alike — the same behaviour as the
 * mailsiem-query.sh CLI on the host, deliberately.
 *
 * It is a substring test and never a RegExp: user input compiled into a pattern
 * is a ReDoS waiting to happen, and none of these lookups need patterns.
 */
export async function search({ q = '', days = DEFAULT_SEARCH_DAYS, blockedOnly = false, limit = 100 } = {}) {
  const needle = normaliseQuery(q).toLowerCase();
  const window = normaliseDays(days);
  const cap = clampInt(limit, 100, 1, MAX_LIMIT);
  const st = status();

  if (!st.mounted) {
    return { rows: [], mounted: false, truncated: false, scanned: 0, filesScanned: 0, days: window };
  }

  const rows = [];
  let scanned = 0;
  let truncated = false;
  let filesScanned = 0;

  const rawFilter = needle ? (line) => line.toLowerCase().includes(needle) : null;

  for (const { file } of dayFiles(window)) {
    if (truncated) break;
    filesScanned += 1;
    // eslint-disable-next-line no-await-in-loop
    scanned += await scanFile(file, rawFilter, (row) => {
      if (blockedOnly && !isBlocked(row.status)) return true;
      rows.push(row);
      if (rows.length >= cap) {
        truncated = true;
        return false;
      }
      return true;
    });
    if (scanned >= MAX_LINES_PER_REQUEST) truncated = true;
  }

  // Newest first. event_time is the filter's own clock; received_at is ours and
  // is always present, so it is the fallback rather than the primary.
  rows.sort((a, b) => String(b.event_time || b.received_at || '').localeCompare(String(a.event_time || a.received_at || '')));

  return { rows, mounted: true, truncated, scanned, filesScanned, days: window };
}

/**
 * Headline counters for the landing page: how much mail was stopped, and what
 * the filter said its reason was.
 *
 * `extra_class` is the field that explains a classification, which makes it the
 * most valuable column here — a run of identical reasons across many senders is
 * what a misconfigured quarantine response looks like from the outside, and is
 * exactly the fault this whole pipeline exists to surface.
 */
export async function summary({ days = DEFAULT_SUMMARY_DAYS } = {}) {
  const window = normaliseDays(days, DEFAULT_SUMMARY_DAYS);
  const st = status();
  if (!st.mounted) {
    return { mounted: false, days: window, total: 0, blocked: 0, reasons: [], byDay: [], truncatedFields: 0 };
  }

  let total = 0;
  let blocked = 0;
  let truncatedFields = 0;
  const reasons = new Map();
  const byDay = new Map();
  let scanned = 0;

  for (const { date, file } of dayFiles(window)) {
    if (scanned >= MAX_LINES_PER_REQUEST) break;
    byDay.set(date, { date, total: 0, blocked: 0 });
    // eslint-disable-next-line no-await-in-loop
    scanned += await scanFile(file, null, (row) => {
      total += 1;
      const day = byDay.get(date);
      day.total += 1;
      // kv_partial marks a value that contained a comma and was truncated by
      // the collector's parser. Surfaced rather than hidden: it means the
      // template's shape changed and the parser needs quoting support.
      if (row.kv_partial) truncatedFields += 1;
      if (isBlocked(row.status)) {
        blocked += 1;
        day.blocked += 1;
        const reason = String(row.extra_class || '').trim() || '(no reason given)';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
      return true;
    });
  }

  return {
    mounted: true,
    days: window,
    total,
    blocked,
    truncatedFields,
    reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Every decision recorded against one filtering id. A message to several
 * recipients produces one decision per recipient — the collector's dedupe key
 * is id + filtering_host + recipient — so this is a list, not a single record.
 */
export async function byId(id, { days = MAX_DAYS } = {}) {
  const wanted = normaliseQuery(id);
  if (!wanted) return { rows: [], mounted: status().mounted, days: normaliseDays(days) };
  const found = await search({ q: wanted, days, limit: MAX_LIMIT });
  return { ...found, rows: found.rows.filter((r) => String(r.id) === wanted) };
}

export default { eventsDir, status, search, summary, byId, isBlocked, dayFiles, normaliseDays, normaliseQuery, MAX_DAYS, DEFAULT_SEARCH_DAYS, DEFAULT_SUMMARY_DAYS, MAX_LIMIT };
