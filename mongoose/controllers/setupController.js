'use strict';

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

const path = require('path');
const configService = require('../../services/configService');
const logger = require('../../services/loggerService');

// ── helpers ──────────────────────────────────────────────────────────────────

function renderSetup(res, view, locals = {}) {
  res.render(path.join('tailwindcss', 'setup', view), {
    layout: false,
    ...locals,
  });
}

function sessionWizard(req) {
  if (!req.session.setupWizard) req.session.setupWizard = {};
  return req.session.setupWizard;
}

// ── step 1: MongoDB ───────────────────────────────────────────────────────────

exports.getStep1 = (req, res) => {
  const w = sessionWizard(req);
  renderSetup(res, 'step1', {
    title: 'Setup — Step 1: Database',
    step: 1,
    values: w.step1 || {},
    error: null,
  });
};

exports.postStep1 = (req, res) => {
  const { mongoUri, mongoHost, mongoPort, mongoUser, mongoPass, mongoAuthSource } = req.body;

  if (!mongoUri && !mongoHost) {
    return renderSetup(res, 'step1', {
      title: 'Setup — Step 1: Database',
      step: 1,
      values: req.body,
      error: 'Provide either a MongoDB URI or a host name.',
    });
  }

  sessionWizard(req).step1 = { mongoUri, mongoHost, mongoPort, mongoUser, mongoPass, mongoAuthSource };
  res.redirect('/setup/step2');
};

// ── AJAX: test DB connection ──────────────────────────────────────────────────

exports.postTestDb = async (req, res) => {
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
    const mongoose = require('mongoose');
    const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
    await new Promise((resolve, reject) => {
      conn.once('open', resolve);
      conn.on('error', reject);
    });
    await conn.close();
    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
};

// ── step 2: company info + secrets ───────────────────────────────────────────

exports.getStep2 = (req, res) => {
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

exports.postStep2 = (req, res) => {
  const { companyName, supportEmail, incorporationYear, sessionSecret, encryptionKey } = req.body;

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

  sessionWizard(req).step2 = { companyName, supportEmail, incorporationYear, sessionSecret, encryptionKey };
  res.redirect('/setup/step3');
};

// ── step 3: first admin user ──────────────────────────────────────────────────

exports.getStep3 = (req, res) => {
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

exports.postComplete = (req, res) => {
  const { adminUsername, adminEmail, adminPassword, adminPasswordConfirm } = req.body;
  const w = sessionWizard(req);

  if (!w.step1 || !w.step2) return res.redirect('/setup');

  if (!adminUsername || !adminUsername.trim()) {
    return renderSetup(res, 'step3', {
      title: 'Setup — Step 3: Admin Account',
      step: 3,
      values: req.body,
      error: 'Username is required.',
    });
  }
  if (!adminPassword || adminPassword.length < 8) {
    return renderSetup(res, 'step3', {
      title: 'Setup — Step 3: Admin Account',
      step: 3,
      values: req.body,
      error: 'Password must be at least 8 characters.',
    });
  }
  if (adminPassword !== adminPasswordConfirm) {
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

  if (s2.companyName)       config.COMPANY_NAME       = s2.companyName.trim();
  if (s2.supportEmail)      config.SUPPORTEMAIL       = s2.supportEmail.trim();
  if (s2.incorporationYear) config.INCORPORATION_YEAR = s2.incorporationYear.trim();

  config.SESSION_SECRET  = s2.sessionSecret;
  config.ENCRYPTION_KEY  = s2.encryptionKey;

  // Bootstrap admin — stored plaintext temporarily; Phase 2 startup hashes +
  // creates the user, then removes these keys from the file immediately.
  config._bootstrapAdmin = {
    username: adminUsername.trim().toLowerCase(),
    email: adminEmail ? adminEmail.trim().toLowerCase() : '',
    password: adminPassword,
  };

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

  // Destroy wizard session then render the "restart" page before exiting
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
