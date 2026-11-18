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
 * Every change it makes in OneDrive (a folder created or moved) and every
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

async function graph(s, method, url, body, what) {
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
    throw new OneDriveError(`OneDrive: ${what} failed: ${err.message}`);
  }
  const data = resp.status === 204 ? {} : await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const code = data?.error?.code || null;
    const msg = data?.error?.message || resp.statusText || 'no detail';
    throw new OneDriveError(`OneDrive: ${what} failed (HTTP ${resp.status}${code ? ` ${code}` : ''}): ${msg}`, { status: resp.status, code });
  }
  return data;
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
 * Move a job's folder into the Completed Jobs folder inside the live jobs
 * folder it is in (created if missing). The name is unchanged. Found by
 * `folderId` when given, else by its "<job no> " prefix in the won year's live
 * jobs folder, then the year before and after. Throws when there is no folder.
 */
export async function moveToCompleted({ projectNumber, site, wonDate, folderId } = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  const number = cleanName(projectNumber);
  if (!number) throw new Error('OneDrive: a job number is needed to find the job folder.');

  let found = null;
  if (folderId) {
    const item = await getItemById(s, folderId);
    if (item) {
      const parentPath = parentPathOf(item);
      if (parentPath !== null) found = { item, path: joinPath(parentPath, item.name), parentPath };
    }
  }
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

  if (lastSegment(found.parentPath) === s.completed) {
    logger.info(`[oneDrive] job ${number}: already in "${found.path}"`);
    return result(found.item, found.path, { moved: false, note: 'Already in Completed Jobs.' });
  }

  const completed = await ensureFolder(s, found.parentPath, s.completed);
  const moved = await moveItem(s, found.item.id, completed.item.id);
  const path = joinPath(completed.path, moved.name || found.item.name);
  logger.info(`[oneDrive] job ${number}: moved "${found.path}" to "${path}"`);
  auditLog.record('onedrive_folder_moved', null, { meta: { owner: s.owner, from: found.path, to: path, itemId: found.item.id, step: 'completed' } });
  return result({ ...found.item, ...moved }, path, { moved: true, from: found.path });
}

/**
 * Find a job's folder without knowing its year: by job number in the live
 * jobs folders (and their Completed Jobs), newest year first, then by quote
 * number in the quotes folders. Null when there is none.
 */
export async function findJobFolder({ quoteNumber, projectNumber } = {}) {
  const s = settings();
  if (!isConfigured(s)) return { ...SKIPPED };
  if (!cleanName(projectNumber) && !cleanName(quoteNumber)) {
    throw new Error('OneDrive: a quote or job number is needed to find a folder.');
  }
  await requireRoot(s);
  const yearFolders = await listFolders(s, s.root);
  const byPattern = (pattern) => {
    const re = new RegExp(`^${cleanName(pattern).split('{year}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d{4})')}$`, 'i');
    return yearFolders
      .map((f) => ({ f, m: re.exec(f.name) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(b.m[1] || 0) - Number(a.m[1] || 0))
      .map((x) => joinPath(s.root, x.f.name));
  };

  if (cleanName(projectNumber)) {
    for (const livePath of byPattern(s.live)) {
      const hit = await findByPrefix(s, livePath, projectNumber)
        || await findByPrefix(s, joinPath(livePath, s.completed), projectNumber);
      if (hit) return result(hit.item, hit.path);
    }
  }
  if (cleanName(quoteNumber)) {
    for (const quotesPath of byPattern(s.quotes)) {
      const hit = await findByPrefix(s, quotesPath, quoteNumber);
      if (hit) return result(hit.item, hit.path);
    }
  }
  return null;
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
  testConnection,
  OneDriveError,
};
