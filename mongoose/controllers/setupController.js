/**
 * setupController — handles the first-run setup wizard.
 *
 * The wizard is only reachable when configService.isConfigured() returns
 * false (i.e. no env vars and no app-config.json).  Once the wizard
 * completes it writes app-config.json and exits the process cleanly so the
 * process manager (Docker, nodemon) restarts with the new config.
 *
 * Steps
 *  GET  /setup           → step 1: MongoDB connection
 *  POST /setup/step1     → validate + store in session, redirect → step 2
 *  POST /setup/test-db   → AJAX connection test (returns JSON)
 *  GET  /setup/step2     → step 2: company info + secrets
 *  POST /setup/step2     → store in session, redirect → step 3
 *  GET  /setup/step3     → step 3: first admin account
 *  POST /setup/complete  → write app-config.json, show restart page
 */

import path from 'path';
import fs from 'fs';
import configService from '../../services/configService.js';
import logger from '../../services/loggerService.js';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

// ── helpers ──────────────────────────────────────────────────────────────────

const DRAFT_FILE = path.join(__dirname, '..', '..', 'config', 'wizard-draft.json');

function readDraft() {
  try {
    if (fs.existsSync(DRAFT_FILE)) return JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function writeDraft(data) {
  try {
    const dir = path.dirname(DRAFT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DRAFT_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn('[setup] Could not write wizard draft: ' + err.message);
  }
}

function deleteDraft() {
  try { if (fs.existsSync(DRAFT_FILE)) fs.unlinkSync(DRAFT_FILE); } catch (_) {}
}

function renderSetup(res, view, locals = {}) {
  res.render(path.join('tailwindcss', 'setup', view), {
    layout: false,
    ...locals,
  });
}

function sessionWizard(req) {
  if (!req.session.setupWizard) {
    // Restore from server-side draft if the session was lost (e.g. container restart).
    // Client localStorage takes precedence — it overwrites these values in the browser.
    req.session.setupWizard = readDraft();
  }
  return req.session.setupWizard;
}

// ── step 1: MongoDB ───────────────────────────────────────────────────────────

export const getStep1 = (req, res) => {
  const w = sessionWizard(req);
  renderSetup(res, 'step1', {
    title: 'Setup — Step 1: Database',
    step: 1,
    values: w.step1 || {},
    error: null,
  });
};

export const postStep1 = (req, res) => {
  const { mongoUri, mongoHost, mongoPort, mongoUser, mongoPass, mongoAuthSource,
          mongoDbRest, mongoDbInternal, mongoDbPaperless } = req.body;

  if (!mongoUri && !mongoHost) {
    return renderSetup(res, 'step1', {
      title: 'Setup — Step 1: Database',
      step: 1,
      values: req.body,
      error: 'Provide either a MongoDB URI or a host name.',
    });
  }

  const w = sessionWizard(req);
  w.step1 = { mongoUri, mongoHost, mongoPort, mongoUser, mongoPass, mongoAuthSource,
              mongoDbRest, mongoDbInternal, mongoDbPaperless };
  writeDraft(w);
  res.redirect('/setup/step2');
};

// ── AJAX: test DB connection ──────────────────────────────────────────────────

export const postTestDb = async (req, res) => {
  const { mongoUri, mongoHost, mongoPort, mongoUser, mongoPass, mongoAuthSource } = req.body;

  if (!mongoUri && !mongoHost) {
    return res.json({ ok: false, error: 'No connection details provided.' });
  }

  let uri;
  if (mongoUri && mongoUri.trim()) {
    uri = mongoUri.trim();
  } else {
    const host = (mongoHost || 'localhost').trim();
    const port = parseInt(mongoPort || '27017', 10);
    if (mongoUser && mongoPass) {
      const u = encodeURIComponent(mongoUser);
      const p = encodeURIComponent(mongoPass);
      const auth = encodeURIComponent(mongoAuthSource || 'admin');
      uri = `mongodb://${u}:${p}@${host}:${port}/?authSource=${auth}`;
    } else {
      uri = `mongodb://${host}:${port}/`;
    }
  }

  try {
    const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
    await new Promise((resolve, reject) => {
      conn.once('open', resolve);
      conn.on('error', reject);
    });
    // Best-effort: list database names so the user can fill the namespace
    // fields with real values (needs listDatabases privilege; ignore if not).
    let databases;
    try {
      const admin = conn.getClient().db().admin();
      const { databases: dbs } = await admin.listDatabases({ nameOnly: true });
      databases = dbs.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    } catch (_) { /* insufficient privileges — omit */ }
    await conn.close();
    return res.json({ ok: true, databases });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
};

// ── step 2: company info + secrets ───────────────────────────────────────────

export const getStep2 = (req, res) => {
  const w = sessionWizard(req);
  if (!w.step1) return res.redirect('/setup');

  renderSetup(res, 'step2', {
    title: 'Setup — Step 2: Company & Secrets',
    step: 2,
    values: w.step2 || {},
    generatedSession: configService.generateSecret(32),
    generatedEncryption: configService.generateSecret(32),
    error: null,
  });
};

export const postStep2 = (req, res) => {
  const { companyName, supportEmail, incorporationYear, notifyEmail, sessionSecret, encryptionKey } = req.body;

  // Skip: no company info, secrets generated server-side (reusing any the
  // wizard already stored, so a revisit doesn't rotate them).
  if (req.body.skip === '1') {
    const w = sessionWizard(req);
    w.step2 = {
      sessionSecret: w.step2?.sessionSecret || configService.generateSecret(32),
      encryptionKey: w.step2?.encryptionKey || configService.generateSecret(32),
      skipped: true,
    };
    writeDraft(w);
    return res.redirect('/setup/step3');
  }

  if (!sessionSecret || sessionSecret.length < 32) {
    return renderSetup(res, 'step2', {
      title: 'Setup — Step 2: Company & Secrets',
      step: 2,
      values: req.body,
      generatedSession: configService.generateSecret(32),
      generatedEncryption: configService.generateSecret(32),
      error: 'Session secret must be at least 32 characters.',
    });
  }
  if (!encryptionKey || encryptionKey.length < 64) {
    return renderSetup(res, 'step2', {
      title: 'Setup — Step 2: Company & Secrets',
      step: 2,
      values: req.body,
      generatedSession: configService.generateSecret(32),
      generatedEncryption: configService.generateSecret(32),
      error: 'Encryption key must be a 64-character hex string (32 bytes). Use the Generate button.',
    });
  }

  const w = sessionWizard(req);
  w.step2 = { companyName, supportEmail, incorporationYear, notifyEmail, sessionSecret, encryptionKey };
  writeDraft(w);
  res.redirect('/setup/step3');
};

// ── step 3: first admin user ──────────────────────────────────────────────────

export const getStep3 = (req, res) => {
  const w = sessionWizard(req);
  if (!w.step1 || !w.step2) return res.redirect('/setup');

  renderSetup(res, 'step3', {
    title: 'Setup — Step 3: Admin Account',
    step: 3,
    values: w.step3 || {},
    error: null,
  });
};

// ── complete: write config + restart ─────────────────────────────────────────

export const postComplete = (req, res) => {
  const { adminUsername, adminEmail, adminPassword, adminPasswordConfirm } = req.body;
  const w = sessionWizard(req);

  if (!w.step1 || !w.step2) return res.redirect('/setup');

  // Skip: no bootstrap admin — for databases that already have users.
  // (Phase 2 only creates the bootstrap admin when the users collection is
  // empty, so skipping is the natural choice for an existing database.)
  const skipAdmin = req.body.skip === '1';

  if (!skipAdmin && (!adminUsername || !adminUsername.trim())) {
    return renderSetup(res, 'step3', {
      title: 'Setup — Step 3: Admin Account',
      step: 3,
      values: req.body,
      error: 'Username is required.',
    });
  }
  if (!skipAdmin && (!adminPassword || adminPassword.length < 8)) {
    return renderSetup(res, 'step3', {
      title: 'Setup — Step 3: Admin Account',
      step: 3,
      values: req.body,
      error: 'Password must be at least 8 characters.',
    });
  }
  if (!skipAdmin && adminPassword !== adminPasswordConfirm) {
    return renderSetup(res, 'step3', {
      title: 'Setup — Step 3: Admin Account',
      step: 3,
      values: req.body,
      error: 'Passwords do not match.',
    });
  }

  const s1 = w.step1;
  const s2 = w.step2;

  // Only write fields that were supplied (don't overwrite env-var equivalents)
  const config = {};

  if (s1.mongoUri && s1.mongoUri.trim()) {
    config.MONGO_URI = s1.mongoUri.trim();
  } else {
    if (s1.mongoHost)       config.MONGO_HOST        = s1.mongoHost.trim();
    if (s1.mongoPort)       config.MONGO_PORT        = s1.mongoPort.trim();
    if (s1.mongoUser)       config.MONGO_USER        = s1.mongoUser.trim();
    if (s1.mongoPass)       config.MONGO_PASS        = s1.mongoPass;
    if (s1.mongoAuthSource) config.MONGO_AUTH_SOURCE = s1.mongoAuthSource.trim();
  }

  // Per-namespace database names (defaults: rest / internal / paperless)
  if (s1.mongoDbRest && s1.mongoDbRest.trim())           config.MONGO_DBNAME_REST      = s1.mongoDbRest.trim();
  if (s1.mongoDbInternal && s1.mongoDbInternal.trim())   config.MONGO_DBNAME_INTERNAL  = s1.mongoDbInternal.trim();
  if (s1.mongoDbPaperless && s1.mongoDbPaperless.trim()) config.MONGO_DBNAME_PAPERLESS = s1.mongoDbPaperless.trim();

  if (s2.companyName)       config.COMPANY_NAME       = s2.companyName.trim();
  if (s2.supportEmail)      config.SUPPORTEMAIL       = s2.supportEmail.trim();
  if (s2.incorporationYear) config.INCORPORATION_YEAR = s2.incorporationYear.trim();
  if (s2.notifyEmail)       config.NOTIFY_EMAIL       = s2.notifyEmail.trim();

  config.SESSION_SECRET  = s2.sessionSecret;
  config.ENCRYPTION_KEY  = s2.encryptionKey;

  // Bootstrap admin — stored plaintext temporarily; Phase 2 startup hashes +
  // creates the user, then removes these keys from the file immediately.
  if (!skipAdmin) {
    config._bootstrapAdmin = {
      username: adminUsername.trim().toLowerCase(),
      email: adminEmail ? adminEmail.trim().toLowerCase() : '',
      password: adminPassword,
    };
  }

  try {
    configService.save(config);
    logger.info('[setup] app-config.json written — restarting…');
  } catch (err) {
    logger.error('[setup] Failed to write app-config.json: ' + err.message);
    return renderSetup(res, 'step3', {
      title: 'Setup — Step 3: Admin Account',
      step: 3,
      values: req.body,
      error: 'Failed to save configuration: ' + err.message,
    });
  }

  // Clean up server draft, destroy wizard session, then render the "restart" page before exiting
  deleteDraft();
  try { req.session.destroy(() => {}); } catch (_) {}

  renderSetup(res, 'complete', {
    title: 'Setup Complete',
    layout: false,
  });

  // Give the response time to flush, then restart so the new config is loaded
  setTimeout(() => {
    logger.info('[setup] Exiting process for clean restart…');
    process.exit(0);
  }, 1500);
};

// ── clear draft ───────────────────────────────────────────────────────────────

export const postClearDraft = (req, res) => {
  deleteDraft();
  try { if (req.session.setupWizard) delete req.session.setupWizard; } catch (_) {}
  res.json({ ok: true });
};

export default { getStep1, postStep1, postTestDb, getStep2, postStep2, getStep3, postComplete, postClearDraft };
