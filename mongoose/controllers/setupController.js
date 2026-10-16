/**
 * setupController — the database wizard, for the one case the app cannot
 * write itself out of: nothing names a reachable MongoDB.
 *
 * Mounted by app.js only when no MONGO_URI/MONGO_HOST is set (environment or
 * the saved bootstrap.json) and none of the bundled-stack hosts answer. It
 * collects the connection details, tests them, persists them to
 * `<FILE_STORAGE_DIR>/.bootstrap/bootstrap.json` (the mounted volume, mode
 * 0600 — never config/app-config.json inside the image) and then hands the
 * running process straight on to Phase 2. No restart.
 *
 * Company details and the first admin are NOT collected here any more: once
 * the database is up, firstRunController takes over at the same /setup URL and
 * writes them directly to the database.
 *
 *  GET  /setup           → database form
 *  POST /setup/test-db   → AJAX connection test (JSON)
 *  POST /setup/complete  → save + continue
 */

import path from 'path';
import mongoose from 'mongoose';
import logger from '../../services/loggerService.js';
import bootstrapSecrets from '../../services/bootstrapSecretsService.js';

function renderSetup(res, view, locals = {}) {
  res.render(path.join('tailwindcss', 'setup', view), {
    layout: false,
    subtitle: 'No database is reachable yet',
    showDraftControls: false,
    ...locals,
  });
}

/** Build a Mongo URI from the form's fields (URI wins when given). */
export function uriFromForm(b = {}) {
  if (b.mongoUri && String(b.mongoUri).trim()) return String(b.mongoUri).trim();
  const host = String(b.mongoHost || 'localhost').trim();
  const port = parseInt(b.mongoPort || '27017', 10) || 27017;
  if (b.mongoUser && b.mongoPass) {
    const u = encodeURIComponent(String(b.mongoUser).trim());
    const p = encodeURIComponent(String(b.mongoPass));
    const auth = encodeURIComponent(String(b.mongoAuthSource || 'admin').trim());
    return `mongodb://${u}:${p}@${host}:${port}/?authSource=${auth}`;
  }
  return `mongodb://${host}:${port}/`;
}

/** Form fields → the env keys bootstrap.json persists. */
export function envFromForm(b = {}) {
  const out = {};
  const s = (v) => (v === undefined || v === null ? '' : String(v).trim());
  if (s(b.mongoUri)) {
    out.MONGO_URI = s(b.mongoUri);
  } else {
    if (s(b.mongoHost)) out.MONGO_HOST = s(b.mongoHost);
    if (s(b.mongoPort)) out.MONGO_PORT = s(b.mongoPort);
    if (s(b.mongoUser)) out.MONGO_USER = s(b.mongoUser);
    if (b.mongoPass) out.MONGO_PASS = String(b.mongoPass);
    if (s(b.mongoAuthSource)) out.MONGO_AUTH_SOURCE = s(b.mongoAuthSource);
  }
  if (s(b.mongoDbRest)) out.MONGO_DBNAME_REST = s(b.mongoDbRest);
  if (s(b.mongoDbInternal)) out.MONGO_DBNAME_INTERNAL = s(b.mongoDbInternal);
  if (s(b.mongoDbPaperless)) out.MONGO_DBNAME_PAPERLESS = s(b.mongoDbPaperless);
  if (s(b.mongoDbWeb)) out.MONGO_DBNAME_WEB = s(b.mongoDbWeb);
  return out;
}

async function tryConnect(uri) {
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await conn.asPromise();
    let databases;
    try {
      const admin = conn.getClient().db().admin();
      const { databases: dbs } = await admin.listDatabases({ nameOnly: true });
      databases = dbs.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    } catch (_) { /* insufficient privileges — omit */ }
    return { ok: true, databases };
  } finally {
    try { await conn.close(); } catch (_) { /* already closed */ }
  }
}

// ── GET /setup ───────────────────────────────────────────────────────────────

export const getStep1 = (req, res) => {
  renderSetup(res, 'step1', {
    title: 'Connect a database',
    values: {},
    error: null,
  });
};

// ── POST /setup/test-db ──────────────────────────────────────────────────────

export const postTestDb = async (req, res) => {
  const b = req.body || {};
  if (!b.mongoUri && !b.mongoHost) {
    return res.json({ ok: false, error: 'No connection details provided.' });
  }
  try {
    return res.json(await tryConnect(uriFromForm(b)));
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
};

// ── POST /setup/complete ─────────────────────────────────────────────────────

/**
 * `onConfigured` is supplied by app.js: it is the continuation that connects
 * to Mongo and mounts the full application in this process.
 */
export function makePostComplete(onConfigured) {
  return async (req, res) => {
    const b = req.body || {};
    const fail = (error) => renderSetup(res, 'step1', { title: 'Connect a database', values: b, error });

    if (!b.mongoUri && !b.mongoHost) return fail('Provide either a MongoDB URI or a host name.');

    try {
      await tryConnect(uriFromForm(b));
    } catch (err) {
      return fail('Could not connect: ' + err.message);
    }

    try {
      bootstrapSecrets.saveBootstrapFile(envFromForm(b));
      logger.info(`[setup] Database settings saved to ${bootstrapSecrets.bootstrapDir()} — continuing startup without a restart`);
    } catch (err) {
      logger.error('[setup] Failed to save database settings: ' + err.message);
      return fail('Could not save the settings: ' + err.message);
    }

    renderSetup(res, 'complete', { title: 'Database connected' });

    // Hand over after the response has gone out; the next request lands on
    // the first-run page once Phase 2 is up (or the maintenance page while
    // it is still connecting).
    setImmediate(() => {
      Promise.resolve()
        .then(() => onConfigured())
        .catch((err) => logger.error('[setup] Continuing startup failed: ' + err.message));
    });
  };
}

export default { getStep1, postTestDb, makePostComplete, uriFromForm, envFromForm };
