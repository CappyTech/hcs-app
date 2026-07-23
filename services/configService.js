/**
 * configService — multi-company configuration layer
 *
 * Priority order (highest to lowest):
 *   1. Environment variables  (process.env)
 *   2. app-config.json        (written by the setup wizard or connections settings UI)
 *   3. Caller-supplied default
 *
 * Existing single-tenant deployments are unaffected: their env vars
 * always take priority, so the file is never consulted.
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
 * Returns true if the key was present in process.env at module load time
 * (i.e. set by docker-compose / OS, not by bootstrap or the UI).
 * Used by the connections settings UI to render an "Env" lock badge.
 * @param {string} key
 * @returns {boolean}
 */
function isFromStartupEnv(key) {
  return _startupEnvKeys.has(key);
}

export default { get, isConfigured, save, remove, generateSecret, bootstrap, isFromStartupEnv };
