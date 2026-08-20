/**
 * configService — multi-company configuration layer
 *
 * Priority order (highest to lowest):
 *   1. Managed store          (Mongo, via configStoreService — admin-editable)
 *   2. Environment variables  (process.env)
 *   3. app-config.json        (written by the setup wizard)
 *   4. Caller-supplied default
 *
 * The managed store sits ABOVE the environment on purpose. With env first, a
 * key set in compose.env could only ever be overridden for the lifetime of the
 * process — which is what made the settings UI advisory rather than
 * authoritative, and why every page had to show an "Env" lock badge. Putting
 * the store first is what allows a deployment to migrate a key out of
 * compose.env without a redeploy: adopt the value here, then drop the line.
 *
 * Only keys in configRegistry can be managed; everything else still resolves
 * from the environment exactly as before. Bootstrap keys (Mongo credentials,
 * SESSION_SECRET, ENCRYPTION_KEY) are excluded by construction — the store
 * lives in the database those keys are needed to reach.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

// Keys present in process.env at module load time (i.e. set by docker-compose / OS env).
// Used by the connections settings UI to show an "Env" badge and warn that these
// cannot be overridden without redeploying.
const _startupEnvKeys = new Set(
  Object.keys(process.env).filter(k => process.env[k] !== undefined && process.env[k] !== '')
);

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'app-config.json');

let _fileConfig = null;

// Managed values from the store, injected by configStoreService once Mongo is
// up. Kept as a plain Map so get() stays synchronous for its ~44 callers.
let _managed = new Map();

// The environment as it stood at startup, so a key can be reverted out of the
// store and back to whatever compose.env supplies.
const _startupEnvValues = Object.freeze({ ...process.env });

function loadFileConfig() {
  if (_fileConfig !== null) return _fileConfig;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      // Strip a UTF-8 BOM if present — a BOM'd file otherwise parses as
      // empty config, and a later save() would rewrite the file from that
      // empty state, silently dropping every existing key.
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
      _fileConfig = JSON.parse(raw);
    } catch (_) {
      _fileConfig = {};
    }
  } else {
    _fileConfig = {};
  }
  return _fileConfig;
}

/**
 * Get a config value.  env var → file → defaultValue.
 * @param {string} key
 * @param {*} [defaultValue]
 * @returns {*}
 */
function get(key, defaultValue = undefined) {
  if (_managed.has(key)) {
    const managedVal = _managed.get(key);
    if (managedVal !== undefined && managedVal !== '') return managedVal;
  }
  const envVal = process.env[key];
  if (envVal !== undefined && envVal !== '') return envVal;
  const fc = loadFileConfig();
  if (fc[key] !== undefined) return fc[key];
  return defaultValue;
}

/**
 * Returns true once the minimum set of config values needed to start the
 * application are present (from env OR app-config.json).
 */
function isConfigured() {
  const hasMongo = !!(get('MONGO_URI') || get('MONGO_HOST'));
  const hasSession = !!get('SESSION_SECRET');
  const hasEncryption = !!get('ENCRYPTION_KEY');
  return hasMongo && hasSession && hasEncryption;
}

/**
 * Persist key/value pairs to app-config.json.
 * Merges with any existing file content (env vars always retain priority at
 * read-time and are never written to the file).
 * @param {Record<string, string>} data
 */
function save(data) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadFileConfig();
  const merged = { ...existing, ...data };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
  _fileConfig = null; // invalidate cache
}

/**
 * Remove specific keys from app-config.json (e.g. bootstrap credentials
 * after first-time admin creation).
 * @param {string[]} keys
 */
function remove(keys) {
  const existing = loadFileConfig();
  for (const k of keys) delete existing[k];
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), 'utf8');
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
  _fileConfig = null;
}

/** Generate a cryptographically random hex string (default 32 bytes = 64 hex chars). */
function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Bootstrap: copy all app-config.json values into process.env for any key
 * not already set by the OS / docker-compose environment.
 * Call once at application startup (after dotenv.config()).
 * This allows settings saved via the connections settings UI to take effect
 * on the next application restart without requiring environment variable changes.
 */
function bootstrap() {
  const fc = loadFileConfig();
  for (const [key, value] of Object.entries(fc)) {
    if (value !== undefined && value !== '' && !process.env[key]) {
      process.env[key] = String(value);
    }
  }
}

/**
 * Replace the managed snapshot. Called by configStoreService after it loads or
 * writes, never by application code.
 * @param {Map<string,string>|Record<string,string>} values
 */
function setManagedSnapshot(values) {
  _managed = values instanceof Map ? new Map(values) : new Map(Object.entries(values || {}));
}

/** The value a key held in process.env at startup (before any store applied). */
function startupEnvValue(key) {
  return _startupEnvValues[key];
}

/**
 * Where the effective value of a key comes from: 'store' | 'env' | 'file' |
 * 'default'. The settings UI shows this, and it is the only way an admin can
 * tell whether editing a field will actually change anything.
 * @param {string} key
 * @returns {'store'|'env'|'file'|'default'}
 */
function sourceOf(key) {
  const managedVal = _managed.get(key);
  if (managedVal !== undefined && managedVal !== '') return 'store';
  const envVal = _startupEnvValues[key];
  if (envVal !== undefined && envVal !== '') return 'env';
  const fc = loadFileConfig();
  if (fc[key] !== undefined && fc[key] !== '') return 'file';
  return 'default';
}

/**
 * Returns true if the key was present in process.env at module load time
 * (i.e. set by docker-compose / OS, not by bootstrap or the UI).
 * Used by the connections settings UI to render an "Env" lock badge.
 * @param {string} key
 * @returns {boolean}
 */
function isFromStartupEnv(key) {
  return _startupEnvKeys.has(key);
}

export default {
  get,
  isConfigured,
  save,
  remove,
  generateSecret,
  bootstrap,
  isFromStartupEnv,
  setManagedSnapshot,
  startupEnvValue,
  sourceOf,
};
