'use strict';

/**
 * configService — multi-company configuration layer
 *
 * Priority order (highest to lowest):
 *   1. Environment variables  (process.env)
 *   2. app-config.json        (written by the setup wizard)
 *   3. Caller-supplied default
 *
 * Existing single-tenant deployments are unaffected: their env vars
 * always take priority, so the file is never consulted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'app-config.json');

let _fileConfig = null;

function loadFileConfig() {
  if (_fileConfig !== null) return _fileConfig;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      _fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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
  _fileConfig = null;
}

/** Generate a cryptographically random hex string (default 32 bytes = 64 hex chars). */
function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { get, isConfigured, save, remove, generateSecret };
