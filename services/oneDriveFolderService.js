/**
 * oneDriveFolderService — job folders in a Microsoft OneDrive.
 *
 * Folders live under a top folder ("Jobs & Quotes") in one user's OneDrive:
 *
 *   Jobs & Quotes/3. QUOTES 2026/51761 3 Centre Court            ← quote added
 *   Jobs & Quotes/1.1 LIVE JOBS 2026/41296 3 Centre Court        ← quote won
 *   Jobs & Quotes/1.1 LIVE JOBS 2026/Completed Jobs/41296 ...    ← job completed
 *
 * Calls are app-only (client credentials) against Microsoft Graph, with the
 * settings from Admin → Config → OneDrive (job folders). The public functions
 * take plain values so the job lifecycle hooks can call them directly, and
 * return `{ id, name, webUrl, path }` (plus what happened), throw an error that
 * says what went wrong, or return `{ skipped: 'not configured' }` without
 * calling anything when the feature is off or incomplete.
 *
 * syncJobFolder puts a folder wherever the job's stage says it should be
 * (back to quotes or live jobs, into a Cancelled folder, renamed after the
 * site or number changed), and folderIndex reads every job folder at once so
 * a whole register can be linked in a few calls.
 *
 * Throttling (429) and passing Graph faults are retried (see graph()).
 *
 * Every change it makes in OneDrive (a folder created, moved or renamed) and every
 * Test connection is a security event (auditLogService, Admin → Security
 * events), attributed to the user whose request did it.
 *
 * The secret and the token are never logged.
 */

import crypto from 'node:crypto';
import configService from './configService.js';
import logger from './loggerService.js';
import auditLog from './auditLogService.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SKIPPED = Object.freeze({ skipped: 'not configured' });

export const DEFAULTS = Object.freeze({
  root: 'Jobs & Quotes',
  quotes: '3. QUOTES {year}',
  live: '1.1 LIVE JOBS {year}',
  completed: 'Completed Jobs',
  cancelled: 'Cancelled',
});

// ── Settings ────────────────────────────────────────────────────────────────

function str(key, fallback = '') {
  const v = configService.get(key, '');
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s || fallback;
}

export function settings() {
  return {
    enabled: /^(1|true|yes|on)$/i.test(str('ONEDRIVE_FOLDERS_ENABLED')),
    tenant: str('ONEDRIVE_TENANT_ID'),
    clientId: str('ONEDRIVE_CLIENT_ID'),
    clientSecret: str('ONEDRIVE_CLIENT_SECRET'),
    owner: str('ONEDRIVE_OWNER'),
    root: str('ONEDRIVE_ROOT_FOLDER', DEFAULTS.root),
    quotes: str('ONEDRIVE_QUOTES_FOLDER', DEFAULTS.quotes),
    live: str('ONEDRIVE_LIVE_FOLDER', DEFAULTS.live),
    completed: str('ONEDRIVE_COMPLETED_FOLDER', DEFAULTS.completed),
    cancelled: str('ONEDRIVE_CANCELLED_FOLDER', DEFAULTS.cancelled),
  };
}

/** Credentials and owner are all present (the enable toggle aside). */
export function hasCredentials(s = settings()) {
  return Boolean(s.tenant && s.clientId && s.clientSecret && s.owner);
}

/** Turned on and complete: the public functions act only when this is true. */
export function isConfigured(s = settings()) {
  return s.enabled && hasCredentials(s);
}

// ── Pure helpers ────────────────────────────────────────────────────────────

// Characters OneDrive refuses in a name, plus control characters.
const FORBIDDEN = /["*:<>?/\\|\x00-\x1f\x7f]/g;

/** A name OneDrive will accept: forbidden characters gone, no trailing dots or spaces. */
export function cleanName(name) {
  return String(name ?? '')
    .replace(FORBIDDEN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
}

/** "3 Centre Court, Alsager" → "3 Centre Court". */
export function siteForFolder(site) {
  return cleanName(String(site ?? '').split(',')[0]);
}

/** "<number> <site>", e.g. "51761 3 Centre Court"; just the number when there is no site. */
export function folderName(number, site) {
  const n = cleanName(number);
  if (!n) throw new Error('OneDrive: a quote or job number is needed to name the folder.');
  const s = siteForFolder(site);
  return s ? `${n} ${s}` : n;
}

/** Calendar year of a date, as seen in the UK. */
export function yearOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (date === null || date === undefined || date === '' || Number.isNaN(d.getTime())) {
    throw new Error(`OneDrive: "${date}" is not a usable date.`);
  }
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(d));
}

/** "3. QUOTES {year}" + a date in 2026 → "3. QUOTES 2026". A number is taken as the year itself. */
export function yearFolder(pattern, date) {
  if (!String(pattern).includes('{year}')) return cleanName(pattern);
  const year = typeof date === 'number' && date > 1900 && date < 3000 ? date : yearOf(date);
  return cleanName(String(pattern).replaceAll('{year}', String(year)));
}

/** Join path segments ("a/b", "c") into "a/b/c", dropping empty segments and stray slashes. */
export function joinPath(...parts) {
  return parts
    .flatMap((p) => String(p ?? '').split('/'))
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');
}

/** Each segment URL-encoded ("Jobs & Quotes/x y" → "Jobs%20%26%20Quotes/x%20y"). */
export function encodePath(path) {
  return joinPath(path).split('/').map(encodeURIComponent).join('/');
}

/** Graph URL of a drive item by its path from the top of the owner's drive. */
export function itemUrl(owner, path, suffix = '') {
  const base = `${GRAPH}/users/${encodeURIComponent(owner)}/drive`;
  const p = joinPath(path);
  if (!p) return `${base}/root${suffix ? `/${suffix}` : ''}`;
  return `${base}/root:/${encodePath(p)}${suffix ? `:/${suffix}` : ''}`;
}

/** Path (from the drive's top) of an item's parent, from Graph's parentReference.path. */
export function parentPathOf(item) {
  const raw = item?.parentReference?.path;
  if (!raw) return null;
  const i = raw.indexOf('root:');
  if (i < 0) return null;
  const rest = raw.slice(i + 5);
  let decoded = rest;
  try { decoded = decodeURIComponent(rest); } catch { /* keep as is */ }
  return joinPath(decoded);
}

function hasPrefix(name, number) {
  const n = cleanName(number);
  return Boolean(n) && (name === n || String(name).startsWith(`${n} `));
}

function lastSegment(path) {
  const parts = joinPath(path).split('/');
  return parts[parts.length - 1] || '';
}

function result(item, path, extra = {}) {
  return { id: item.id, name: item.name, webUrl: item.webUrl || null, path, ...extra };
}

// ── Graph ───────────────────────────────────────────────────────────────────

export class OneDriveError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'OneDriveError';
    this.status = status;
    this.code = code;
  }
}

let _token = { value: null, expiresAt: 0, key: null };

/** Forget the cached token (after the settings are saved). */
export function resetToken() {
  _token = { value: null, expiresAt: 0, key: null };
}

/** App-only access token via client credentials, cached until a minute before it expires. */
export async function getToken(s = settings()) {
  if (!hasCredentials(s)) throw new OneDriveError('OneDrive is not configured (tenant / client ID / client secret / owner).');
  // Keyed on the credentials (hashed), so changing any of them fetches a new token.
  const key = crypto.createHash('sha256').update(`${s.tenant}|${s.clientId}|${s.clientSecret}`).digest('hex');
  if (_token.value && _token.key === key && Date.now() < _token.expiresAt - 60_000) return _token.value;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(s.tenant)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: s.clientId,
    client_secret: s.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OneDriveError(`OneDrive token request failed: ${err.message}`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${resp.status}`;
    throw new OneDriveError(`OneDrive token request failed: ${String(detail).split(/\r?\n/)[0].trim()}`, { status: resp.status, code: data.error || null });
  }
  _token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000, key };
  logger.info('[oneDrive] access token acquired');
  return _token.value;
}

// Graph throttles (429) and has the odd bad moment (502/503/504, a dropped
// connection). Those are tried again, up to MAX_RETRIES times, waiting as long
// as Graph's Retry-After says (capped), else 1s, 2s, 4s. Retrying is safe:
// a create uses conflictBehavior "fail", so a repeat of one that did land
// comes back as 409 (already there), and a move to the same place is a no-op.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 30_000;

let _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tests replace the wait between retries (null puts the real one back). */
export function setSleepForTests(fn) {
  _sleep = fn || ((ms) => new Promise((r) => setTimeout(r, ms)));
}

/** How long to wait before retry number `attempt` (0-based), from Retry-After (seconds or a date) if given. */
export function retryDelay(retryAfter, attempt) {
  const backoff = 1000 * 2 ** attempt;
  if (retryAfter === null || retryAfter === undefined || retryAfter === '') return backoff;
  const secs = Number(retryAfter);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(ms)) return backoff;
  return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

async function graph(s, method, url, body, what) {
  let refreshed = false;
  for (let attempt = 0; ; attempt += 1) {
    const token = await getToken(s);
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn(`[oneDrive] ${what}: ${err.message}; trying again`);
        await _sleep(retryDelay(null, attempt));
        continue;
      }
      throw new OneDriveError(`OneDrive: ${what} failed: ${err.message}`);
    }
    if (RETRY_STATUSES.has(resp.status) && attempt < MAX_RETRIES) {
      const wait = retryDelay(resp.headers?.get?.('Retry-After'), attempt);
      logger.warn(`[oneDrive] ${what}: HTTP ${resp.status}; trying again in ${Math.round(wait / 1000)}s`);
      await resp.body?.cancel?.().catch(() => {});
      await _sleep(wait);
      continue;
    }
    // A token Graph no longer accepts (revoked, or the secret changed under
    // it): fetch a new one and try once more.
    if (resp.status === 401 && !refreshed) {
      refreshed = true;
      attempt -= 1;
      resetToken();
      await resp.body?.cancel?.().catch(() => {});
      continue;
    }
    const data = resp.status === 204 ? {} : await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const code = data?.error?.code || null;
      const msg = data?.error?.message || resp.statusText || 'no detail';
      throw new OneDriveError(`OneDrive: ${what} failed (HTTP ${resp.status}${code ? ` ${code}` : ''}): ${msg}`, { status: resp.status, code });
    }
    return data;
  }
}

// A 404 for the item itself means "not there"; any other 404 (e.g. no such
// owner) is a real error and is thrown.
function isItemMissing(err) {
  return err instanceof OneDriveError && err.status === 404 && (!err.code || err.code === 'itemNotFound');
}

/** The item at a path, or null. */
export async function getItemByPath(s, path) {
  try {
    return await graph(s, 'GET', itemUrl(s.owner, path), null, `reading "${joinPath(path)}"`);
  } catch (err) {
    if (isItemMissing(err)) return null;
    throw err;
  }
}

/** The item with an id, or null. */
export async function getItemById(s, id) {
  try {
    return await graph(s, 'GET', `${GRAPH}/users/${encodeURIComponent(s.owner)}/drive/items/${encodeURIComponent(id)}`, null, `reading item ${id}`);
  } catch (err) {
    if (isItemMissing(err)) return null;
    throw err;
  }
}

/** The folders directly inside a path ([] when the path does not exist). */
export async function listFolders(s, path) {
  let url = `${itemUrl(s.owner, path, 'children')}?$select=id,name,webUrl,folder,parentReference&$top=999`;
  const out = [];
  try {
    while (url) {
      const data = await graph(s, 'GET', url, null, `listing "${joinPath(path)}"`);
      out.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
  } catch (err) {
    if (isItemMissing(err)) return [];
    throw err;
  }
  return out.filter((i) => i.folder);
}

/**
 * Create a folder inside a path. A 409 means it is already there, which is
 * fine: the existing one is returned with `existed: true`.
 */
export async function createFolder(s, parentPath, name) {
  const path = joinPath(parentPath, name);
  try {
    const item = await graph(s, 'POST', itemUrl(s.owner, parentPath, 'children'), {
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }, `creating "${path}"`);
    logger.info(`[oneDrive] created folder "${path}"`);
    auditLog.record('onedrive_folder_created', null, { meta: { owner: s.owner, path, itemId: item.id } });
    return { item, existed: false };
  } catch (err) {
    if (!(err instanceof OneDriveError) || err.status !== 409) throw err;
    const item = await getItemByPath(s, path);
    if (!item) throw err;
    return { item, existed: true };
  }
}

/** Move an item into another folder, renaming it when a name is given. */
export async function moveItem(s, id, parentId, name) {
  const body = { parentReference: { id: parentId }, ...(name ? { name } : {}) };
  try {
    return await graph(s, 'PATCH', `${GRAPH}/users/${encodeURIComponent(s.owner)}/drive/items/${encodeURIComponent(id)}`, body, `moving item ${id}`);
  } catch (err) {
    if (err instanceof OneDriveError && err.status === 409) {
      throw new OneDriveError(`OneDrive: could not move the folder, because a folder${name ? ` named "${name}"` : ' with the same name'} is already there.`, { status: 409, code: err.code });
    }
    throw err;
  }
}

async function requireRoot(s) {
  const root = await getItemByPath(s, s.root);
  if (!root) throw new OneDriveError(`OneDrive: the top folder "${s.root}" was not found in ${s.owner}'s OneDrive.`, { status: 404, code: 'itemNotFound' });
  return root;
}

/** A folder inside `parentPath`, created if missing. */
async function ensureFolder(s, parentPath, name) {
  const path = joinPath(parentPath, name);
  const found = await getItemByPath(s, path);
  if (found) return { item: found, path };
  const { item } = await createFolder(s, parentPath, name);
  return { item, path };
}

async function findByPrefix(s, parentPath, number) {
  const folders = await listFolders(s, parentPath);
  const item = folders.find((f) => hasPrefix(f.name, number));
  return item ? { item, path: joinPath(parentPath, item.name), parentPath } : null;
}

function nearbyYears(year) {
  return [year, year - 1, year + 1];
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * The quote's folder in the quotes folder for the quote date's year, created
 * if missing. A folder already starting with the quote number is reused, even
 * if the site part differs.
 */
export async function ensureQuoteFolder({ quoteNumber, site, quoteDate } = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  const name = folderName(quoteNumber, site);
  const yearName = yearFolder(s.quotes, quoteDate);

  await requireRoot(s);
  const year = await ensureFolder(s, s.root, yearName);
  const existing = await findByPrefix(s, year.path, quoteNumber);
  if (existing) {
    logger.info(`[oneDrive] quote ${quoteNumber}: folder already there ("${existing.path}")`);
    return result(existing.item, existing.path, { created: false });
  }
  const { item, existed } = await createFolder(s, year.path, name);
  const path = joinPath(year.path, item.name);
  return result(item, path, { created: !existed });
}

/**
 * Move a won quote's folder to the live jobs folder for the year it was won,
 * renamed "<job no> <site>". The quote folder is found by `folderId` when
 * given, else by its "<quote no> " prefix in the quote year's folder, then the
 * year before and after. With no quote folder to move, the live folder is
 * created and the result says so (`created: true`, `note`).
 */
export async function moveToLive({ quoteNumber, projectNumber, site, quoteDate, wonDate, folderId } = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  const name = folderName(projectNumber, site);
  const won = wonDate ?? new Date();
  const liveName = yearFolder(s.live, won);

  await requireRoot(s);

  // Already moved (a repeat call): leave it be.
  const livePath = joinPath(s.root, liveName);
  const already = await findByPrefix(s, livePath, projectNumber);
  if (already) {
    logger.info(`[oneDrive] job ${projectNumber}: already in "${already.path}"`);
    return result(already.item, already.path, { moved: false, created: false, note: 'Already in the live jobs folder.' });
  }

  let source = null;
  if (folderId) {
    const item = await getItemById(s, folderId);
    if (item) source = { item, path: joinPath(parentPathOf(item), item.name) };
  }
  if (!source && cleanName(quoteNumber)) {
    const baseYear = yearOf(quoteDate ?? won);
    for (const y of nearbyYears(baseYear)) {
      source = await findByPrefix(s, joinPath(s.root, yearFolder(s.quotes, y)), quoteNumber);
      if (source) break;
    }
  }

  const live = await ensureFolder(s, s.root, liveName);
  if (!source) {
    const { item, existed } = await createFolder(s, live.path, name);
    const note = `No folder for quote ${quoteNumber || '(none)'} was found, so a new live job folder was created.`;
    logger.warn(`[oneDrive] job ${projectNumber}: ${note}`);
    return result(item, joinPath(live.path, item.name), { moved: false, created: !existed, note });
  }

  const moved = await moveItem(s, source.item.id, live.item.id, name);
  const path = joinPath(live.path, moved.name || name);
  logger.info(`[oneDrive] job ${projectNumber}: moved "${source.path}" to "${path}"`);
  auditLog.record('onedrive_folder_moved', null, { meta: { owner: s.owner, from: source.path, to: path, itemId: source.item.id, step: 'won' } });
  return result({ ...source.item, ...moved }, path, { moved: true, created: false, from: source.path });
}

/**
 * Move a job's folder into the Completed Jobs folder of the live jobs folder
 * it is in (created if missing). The name is unchanged. Found by `folderId`
 * when given, else by its "<job no> " prefix in the won year's live jobs
 * folder, then the year before and after. A folder that isn't in a live jobs
 * folder (still in quotes, or in Cancelled) goes to the won year's. Throws
 * when there is no folder.
 */
export async function moveToCompleted({ projectNumber, site, wonDate, folderId } = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  const number = cleanName(projectNumber);
  if (!number) throw new Error('OneDrive: a job number is needed to find the job folder.');

  let found = null;
  if (folderId) found = await byId(s, folderId);
  if (!found) {
    await requireRoot(s);
    const baseYear = yearOf(wonDate ?? new Date());
    for (const y of nearbyYears(baseYear)) {
      const livePath = joinPath(s.root, yearFolder(s.live, y));
      found = await findByPrefix(s, livePath, number)
        || await findByPrefix(s, joinPath(livePath, s.completed), number);
      if (found) break;
    }
  }
  if (!found) {
    const where = yearFolder(s.live, wonDate ?? new Date());
    throw new OneDriveError(`OneDrive: no folder for job ${number}${site ? ` (${siteForFolder(site)})` : ''} was found in "${where}" or the years either side.`, { status: 404, code: 'itemNotFound' });
  }

  const at = locate(s, found.parentPath);
  if (at.kind === 'live' && at.sub === 'completed') {
    logger.info(`[oneDrive] job ${number}: already in "${found.path}"`);
    return result(found.item, found.path, { moved: false, note: 'Already in Completed Jobs.' });
  }

  const livePath = at.kind === 'live' ? at.yearPath : joinPath(s.root, yearFolder(s.live, wonDate ?? new Date()));
  if (at.kind !== 'live') await ensureFolder(s, s.root, lastSegment(livePath));
  const completed = await ensureFolder(s, livePath, s.completed);
  const moved = await moveItem(s, found.item.id, completed.item.id);
  const path = joinPath(completed.path, moved.name || found.item.name);
  logger.info(`[oneDrive] job ${number}: moved "${found.path}" to "${path}"`);
  auditLog.record('onedrive_folder_moved', null, { meta: { owner: s.owner, from: found.path, to: path, itemId: found.item.id, step: 'completed' } });
  return result({ ...found.item, ...moved }, path, { moved: true, from: found.path });
}

// ── Where a folder is, and where it should be ───────────────────────────────

/** The item with an id and where it is, or null (gone, or not in this drive's tree). */
async function byId(s, id) {
  const item = await getItemById(s, id);
  if (!item) return null;
  const parentPath = parentPathOf(item);
  if (parentPath === null) return null;
  return { item, path: joinPath(parentPath, item.name), parentPath };
}

/** A year folder pattern ("3. QUOTES {year}") as a regex whose group 1 is the year. */
export function patternRegex(pattern) {
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${cleanName(pattern).split('{year}').map(esc).join('(\\d{4})')}$`, 'i');
}

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * Where a parent path sits in the folder structure:
 *   { kind: 'quotes' | 'live', year, yearPath, sub: null | 'completed' | 'cancelled' }
 * or { kind: null } for anywhere else (outside the top folder, an unknown
 * folder, deeper down). Pure, given the settings.
 */
export function locate(s, parentPath) {
  const none = { kind: null, year: null, yearPath: null, sub: null };
  const root = joinPath(s.root);
  const p = joinPath(parentPath);
  if (!p || !(same(p, root) || p.toLowerCase().startsWith(`${root.toLowerCase()}/`))) return none;
  const rest = p.slice(root.length).split('/').filter(Boolean);
  if (rest.length < 1 || rest.length > 2) return none;
  const [yearName, subName] = rest;
  let kind = null;
  let m = patternRegex(s.live).exec(yearName);
  if (m) kind = 'live';
  else if ((m = patternRegex(s.quotes).exec(yearName))) kind = 'quotes';
  if (!kind) return none;
  let sub = null;
  if (subName !== undefined) {
    if (same(subName, s.cancelled)) sub = 'cancelled';
    else if (kind === 'live' && same(subName, s.completed)) sub = 'completed';
    else return none;
  }
  const year = m[1] ? Number(m[1]) : null;
  return { kind, year, yearPath: joinPath(s.root, yearName), sub };
}

/** Which folder a job's stage puts its folder in. */
export const STAGE_PLACE = Object.freeze({
  toQuote: 'quotes', quoted: 'quotes', won: 'live', completed: 'completed', invoiced: 'completed', cancelled: 'cancelled',
});

/**
 * Where a job's folder should be, given where it is now (`at`, from locate):
 * `{ kind, year, sub, number }`, or `{ wait: why }` when it can't be said yet.
 * A folder already in the right kind of year folder keeps its year; one
 * moving to another kind takes the year of the quote date (quotes) or the won
 * date (live jobs). A cancelled job stays in the year folder it's in. Pure.
 */
export function placeFor({ stage, quoteNumber, projectNumber, quoteDate, wonDate }, at = { kind: null }, now = new Date()) {
  const place = STAGE_PLACE[stage];
  if (!place) return { wait: `"${stage}" is not a stage the folders know.` };
  const hasQuote = Boolean(cleanName(quoteNumber));
  const hasJob = Boolean(cleanName(projectNumber));
  if (place === 'quotes') {
    if (!hasQuote) return { wait: 'The job has no quote number to name its folder.' };
    return { kind: 'quotes', sub: null, year: at.kind === 'quotes' ? at.year : yearOf(quoteDate ?? now), number: quoteNumber };
  }
  if (place === 'live' || place === 'completed') {
    if (!hasJob) return { wait: 'The job has no project number yet.' };
    return { kind: 'live', sub: place === 'completed' ? 'completed' : null, year: at.kind === 'live' ? at.year : yearOf(wonDate ?? now), number: projectNumber };
  }
  // Cancelled: in the year folder it's in, or (outside the structure) the
  // one it would be in if it were live.
  const number = hasJob ? projectNumber : quoteNumber;
  if (!cleanName(number)) return { wait: 'The job has no number to name its folder.' };
  if (at.kind) return { kind: at.kind, sub: 'cancelled', year: at.year, number };
  return hasJob
    ? { kind: 'live', sub: 'cancelled', year: yearOf(wonDate ?? now), number }
    : { kind: 'quotes', sub: 'cancelled', year: yearOf(quoteDate ?? now), number };
}

/** The year folders under the top folder whose names fit a pattern, newest first. */
function yearFoldersFor(s, yearFolders, pattern) {
  const re = patternRegex(pattern);
  return yearFolders
    .map((f) => ({ f, m: re.exec(f.name) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m[1] || 0) - Number(a.m[1] || 0))
    .map((x) => joinPath(s.root, x.f.name));
}

/**
 * A job's folder by its numbers, without knowing its year: by job number in
 * the live jobs folders (and their Completed Jobs and Cancelled), newest year
 * first, then by quote number in the quotes folders (and their Cancelled).
 */
async function searchJobFolder(s, { quoteNumber, projectNumber }) {
  const yearFolders = await listFolders(s, s.root);
  if (cleanName(projectNumber)) {
    for (const livePath of yearFoldersFor(s, yearFolders, s.live)) {
      const hit = await findByPrefix(s, livePath, projectNumber)
        || await findByPrefix(s, joinPath(livePath, s.completed), projectNumber)
        || await findByPrefix(s, joinPath(livePath, s.cancelled), projectNumber);
      if (hit) return hit;
    }
  }
  if (cleanName(quoteNumber)) {
    for (const quotesPath of yearFoldersFor(s, yearFolders, s.quotes)) {
      const hit = await findByPrefix(s, quotesPath, quoteNumber)
        || await findByPrefix(s, joinPath(quotesPath, s.cancelled), quoteNumber);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Find a job's folder without knowing its year (see searchJobFolder). Null
 * when there is none.
 */
export async function findJobFolder({ quoteNumber, projectNumber } = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  if (!cleanName(projectNumber) && !cleanName(quoteNumber)) {
    throw new Error('OneDrive: a quote or job number is needed to find a folder.');
  }
  await requireRoot(s);
  const hit = await searchJobFolder(s, { quoteNumber, projectNumber });
  return hit ? result(hit.item, hit.path) : null;
}

/** The year folder (and Completed Jobs / Cancelled inside it) a place names, created as needed. */
async function ensurePlace(s, place) {
  const pattern = place.kind === 'live' ? s.live : s.quotes;
  const year = await ensureFolder(s, s.root, yearFolder(pattern, place.year));
  if (!place.sub) return year;
  return ensureFolder(s, year.path, place.sub === 'completed' ? s.completed : s.cancelled);
}

function placePath(s, place) {
  const pattern = place.kind === 'live' ? s.live : s.quotes;
  const sub = place.sub === 'completed' ? s.completed : place.sub === 'cancelled' ? s.cancelled : '';
  return joinPath(s.root, yearFolder(pattern, place.year), sub);
}

/**
 * Put a job's folder where its stage says it should be, and say where it is.
 *
 *   stage         the job's stage (jobRegisterService.stageOf)
 *   folderId      the folder kept on the job, if any; else (or if it's gone)
 *                 it is looked for by number, as Find folder does
 *   rename        'always': the folder is named "<number> <site>" exactly;
 *                 'number' (the default): only when it doesn't already start
 *                 with the right number, so a name tidied by hand is kept
 *   create        make the folder where it should be when there is none
 *                 (never for a cancelled job)
 *   step          what the move is recorded as in the security events
 *
 * Returns the folder with `moved`, `renamed`, `created` and `from`, plus a
 * `note` when it couldn't be put anywhere yet; null when there is no folder
 * (and none was made); { skipped } when OneDrive is off.
 */
export async function syncJobFolder({
  stage, quoteNumber, projectNumber, site, quoteDate, wonDate, folderId, rename = 'number', create = true, step = 'sync',
} = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  if (!cleanName(projectNumber) && !cleanName(quoteNumber) && !folderId) {
    throw new Error('OneDrive: a quote or job number is needed to find a folder.');
  }
  const job = { stage, quoteNumber, projectNumber, quoteDate, wonDate };
  await requireRoot(s);

  let found = folderId ? await byId(s, folderId) : null;
  if (!found && (cleanName(projectNumber) || cleanName(quoteNumber))) found = await searchJobFolder(s, { quoteNumber, projectNumber });

  if (!found) {
    if (!create || STAGE_PLACE[stage] === 'cancelled') return null;
    const place = placeFor(job);
    if (place.wait) return null;
    const parent = await ensurePlace(s, place);
    const { item, existed } = await createFolder(s, parent.path, folderName(place.number, site));
    return result(item, joinPath(parent.path, item.name), { moved: false, renamed: false, created: !existed });
  }

  const at = locate(s, found.parentPath);
  const place = placeFor(job, at);
  if (place.wait) {
    return result(found.item, found.path, { moved: false, renamed: false, created: false, note: `Left where it is: ${place.wait}` });
  }
  const wantName = rename === 'always' || !hasPrefix(found.item.name, place.number)
    ? folderName(place.number, site)
    : found.item.name;
  const wantParent = placePath(s, place);
  const move = !same(wantParent, found.parentPath);
  const renamed = wantName !== found.item.name;
  if (!move && !renamed) return result(found.item, found.path, { moved: false, renamed: false, created: false });

  const parentId = move ? (await ensurePlace(s, place)).item.id : found.item.parentReference?.id;
  let moved;
  if (parentId) {
    moved = await moveItem(s, found.item.id, parentId, renamed ? wantName : undefined);
  } else {
    // No parent id from Graph (unusual): a rename in place needs no parent.
    moved = await graph(s, 'PATCH', `${GRAPH}/users/${encodeURIComponent(s.owner)}/drive/items/${encodeURIComponent(found.item.id)}`, { name: wantName }, `renaming item ${found.item.id}`);
  }
  const path = joinPath(move ? wantParent : found.parentPath, moved.name || wantName);
  const meta = { owner: s.owner, from: found.path, to: path, itemId: found.item.id, step };
  if (move) {
    logger.info(`[oneDrive] moved "${found.path}" to "${path}" (${step})`);
    auditLog.record('onedrive_folder_moved', null, { meta });
  } else {
    logger.info(`[oneDrive] renamed "${found.path}" to "${path}" (${step})`);
    auditLog.record('onedrive_folder_renamed', null, { meta });
  }
  return result({ ...found.item, ...moved }, path, { moved: move, renamed, created: false, from: found.path });
}

/** The number a folder name starts with ("41296 3 Centre Court" → "41296"), or null. */
export function leadingNumber(name) {
  const m = /^(\d+)(?:\s|$)/.exec(String(name ?? ''));
  return m ? m[1] : null;
}

/**
 * Every job folder in the structure, read once, for linking many jobs:
 * `{ live: Map<job no, folder>, quotes: Map<quote no, folder> }`. Live holds
 * the live jobs folders with their Completed Jobs and Cancelled; quotes the
 * quotes folders with their Cancelled. Where a number is in two years the
 * newest wins. Reads only.
 */
export async function folderIndex() {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  await requireRoot(s);
  const yearFolders = await listFolders(s, s.root);
  const read = async (paths) => {
    const map = new Map();
    for (const path of paths) {
      for (const f of await listFolders(s, path)) {
        const n = leadingNumber(f.name);
        if (n && !map.has(n)) map.set(n, result(f, joinPath(path, f.name)));
      }
    }
    return map;
  };
  const live = yearFoldersFor(s, yearFolders, s.live).flatMap((p) => [p, joinPath(p, s.completed), joinPath(p, s.cancelled)]);
  const quotes = yearFoldersFor(s, yearFolders, s.quotes).flatMap((p) => [p, joinPath(p, s.cancelled)]);
  return { live: await read(live), quotes: await read(quotes) };
}

/**
 * The Test connection button: read the top folder with the saved credentials
 * (the enable toggle is ignored, so it can be checked before switching on).
 * Reads only.
 */
export async function testConnection() {
  const s = settings();
  try {
    const message = await checkConnection(s);
    auditLog.record('onedrive_connection_tested', null, { meta: { ok: true, owner: s.owner, root: s.root, message } });
    return message;
  } catch (err) {
    auditLog.record('onedrive_connection_tested', null, { meta: { ok: false, owner: s.owner || null, root: s.root, error: err.message } });
    throw err;
  }
}

async function checkConnection(s) {
  if (!hasCredentials(s)) throw new Error('OneDrive tenant / client ID / client secret / owner not configured.');
  let root;
  try {
    root = await getItemByPath(s, s.root);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new Error(`${err.message} Check the app registration has the Microsoft Graph application permission Files.ReadWrite.All with admin consent.`);
    }
    throw err;
  }
  if (!root) throw new Error(`Signed in, but the top folder "${s.root}" was not found in ${s.owner}'s OneDrive.`);
  const count = root.folder?.childCount;
  return `Found "${s.root}" in ${s.owner}'s OneDrive${count !== undefined ? ` (${count} item${count === 1 ? '' : 's'} inside)` : ''}.${s.enabled ? '' : ' Job folder management is still switched off.'}`;
}

export default {
  DEFAULTS,
  settings,
  hasCredentials,
  isConfigured,
  cleanName,
  siteForFolder,
  folderName,
  yearOf,
  yearFolder,
  joinPath,
  encodePath,
  itemUrl,
  parentPathOf,
  resetToken,
  getToken,
  ensureQuoteFolder,
  moveToLive,
  moveToCompleted,
  findJobFolder,
  syncJobFolder,
  folderIndex,
  locate,
  placeFor,
  patternRegex,
  leadingNumber,
  retryDelay,
  setSleepForTests,
  STAGE_PLACE,
  testConnection,
  OneDriveError,
};
