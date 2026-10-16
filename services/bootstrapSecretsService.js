/**
 * bootstrapSecretsService — the two secrets the app needs before it can read
 * its own configuration, made self-writing.
 *
 * A deployment must never need a human to edit a file: `docker compose up`,
 * open the URL, and the system writes itself. The managed configuration store
 * (configStoreService) already covers everything that can live in Mongo, but
 * two keys sit underneath it:
 *
 *   ENCRYPTION_KEY  encrypts the store's own secrets (and TOTP secrets), so it
 *                   cannot live in the store. It is kept in a key file under
 *                   FILE_STORAGE_DIR — the one mounted volume — written by the
 *                   app with mode 0600, and read back on every start.
 *
 *   SESSION_SECRET  signs the session cookie and encrypts the Mongo session
 *                   store. It is needed only once Mongo is up, so it lives in
 *                   the INTERNAL appconfigs collection (encrypted with the key
 *                   above) and survives restarts and image pulls alike.
 *
 * The environment still wins for both: a value in compose.env is used as-is
 * and nothing is generated or written. A generated key is only ever created
 * when the env is silent, and only once.
 *
 * The Mongo connection the wizard collects when nothing can reach a database
 * is persisted here too, in bootstrap.json next to the key file, rather than in
 * config/app-config.json inside the image (which every `docker compose pull`
 * destroys).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import logger from './loggerService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ENCRYPTION_KEY_FILE = 'encryption.key';
export const BOOTSTRAP_FILE = 'bootstrap.json';
export const SESSION_SECRET_DOC_KEY = 'SESSION_SECRET';

/** Settings the Mongo wizard may persist. Anything else is dropped. */
export const BOOTSTRAP_MONGO_KEYS = [
  'MONGO_URI', 'MONGO_HOST', 'MONGO_PORT', 'MONGO_USER', 'MONGO_PASS', 'MONGO_AUTH_SOURCE',
  'MONGO_DBNAME_REST', 'MONGO_DBNAME_INTERNAL', 'MONGO_DBNAME_PAPERLESS', 'MONGO_DBNAME_WEB',
];

/**
 * Where the app keeps what it writes for itself: `<FILE_STORAGE_DIR>/.bootstrap`.
 * Resolved per call rather than at import so tests (and the wizard, which may
 * learn the dir late) see the current value. Without FILE_STORAGE_DIR it sits
 * in ./storage next to the app, the same default fileStorage.js uses.
 */
export function bootstrapDir(storageRoot = process.env.FILE_STORAGE_DIR) {
  const root = storageRoot ? path.resolve(storageRoot) : path.join(__dirname, '..', 'storage');
  return path.join(root, '.bootstrap');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* Windows */ }
}

function writePrivate(file, contents) {
  ensureDir(path.dirname(file));
  // Write-then-rename so a crash mid-write never leaves a truncated key file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows */ }
  fs.renameSync(tmp, file);
}

export function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// ── ENCRYPTION_KEY ───────────────────────────────────────────────────────────

/**
 * Make sure process.env.ENCRYPTION_KEY is set, generating and persisting a key
 * file when the environment does not supply one. Synchronous on purpose: it
 * must run before anything imports encryptionService.
 *
 * @returns {{ source: 'env'|'file'|'generated', file: string|null }}
 */
export function ensureEncryptionKey({ env = process.env, dir = bootstrapDir(env.FILE_STORAGE_DIR), log = logger } = {}) {
  if (env.ENCRYPTION_KEY) return { source: 'env', file: null };

  const file = path.join(dir, ENCRYPTION_KEY_FILE);
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8').trim(); } catch (_) { /* absent */ }

  if (existing) {
    env.ENCRYPTION_KEY = existing;
    log.info(`[bootstrap] ENCRYPTION_KEY read from ${file}. Back this file up with the storage volume: losing it loses every stored secret (TOTP, managed credentials).`);
    return { source: 'file', file };
  }

  const key = generateSecret(32);
  writePrivate(file, key + '\n');
  env.ENCRYPTION_KEY = key;
  log.warn(`[bootstrap] No ENCRYPTION_KEY in the environment — generated one and wrote it to ${file} (mode 0600). It is now part of this deployment's data: back it up with the storage volume. Losing it loses every stored secret (TOTP, managed credentials). To move it into the environment instead, copy the file's contents into ENCRYPTION_KEY.`);
  return { source: 'generated', file };
}

// ── SESSION_SECRET ───────────────────────────────────────────────────────────

/**
 * Make sure process.env.SESSION_SECRET is set, reading or creating the persisted
 * one in the INTERNAL appconfigs collection when the environment is silent.
 *
 * The stored value is encrypted with encryptionService so a database dump does
 * not hand out the cookie-signing key. A value that no longer decrypts (the
 * encryption key was lost) is replaced: every session is invalidated, which is
 * the only honest outcome, and the log says so.
 *
 * @param {import('mongoose').Model} AppConfig  the INTERNAL.appConfig model
 * @param {{ encrypt(string):string, decrypt(string):string }} enc
 * @returns {Promise<{ source: 'env'|'db'|'generated' }>}
 */
export async function ensureSessionSecret(AppConfig, enc, { env = process.env, log = logger } = {}) {
  if (env.SESSION_SECRET) return { source: 'env' };
  if (!AppConfig) throw new Error('bootstrapSecrets: appConfig model is not available');

  const doc = await AppConfig.findOne({ key: SESSION_SECRET_DOC_KEY }).lean();
  if (doc && typeof doc.value === 'string' && doc.value) {
    try {
      const plain = enc.decrypt(doc.value);
      if (plain) {
        env.SESSION_SECRET = plain;
        return { source: 'db' };
      }
    } catch (err) {
      log.error(`[bootstrap] Stored SESSION_SECRET could not be decrypted (${err.message}) — the encryption key has changed. Generating a new one; every existing session is now invalid.`);
    }
  }

  const secret = generateSecret(32);
  await AppConfig.findOneAndUpdate(
    { key: SESSION_SECRET_DOC_KEY },
    { key: SESSION_SECRET_DOC_KEY, value: enc.encrypt(secret), secret: true, updatedBy: 'system' },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  env.SESSION_SECRET = secret;
  log.warn('[bootstrap] No SESSION_SECRET in the environment — generated one and stored it (encrypted) in INTERNAL.appconfigs. It persists across restarts; set SESSION_SECRET in the environment to take it over.');
  return { source: 'generated' };
}

// ── Mongo connection collected by the wizard ─────────────────────────────────

/** Read bootstrap.json; `{}` when absent or unreadable. */
export function readBootstrapFile(dir = bootstrapDir()) {
  try {
    const raw = fs.readFileSync(path.join(dir, BOOTSTRAP_FILE), 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Persist the Mongo connection settings the wizard collected (0600) and apply
 * them to process.env for keys the environment does not already set. Only the
 * Mongo keys are accepted; the file is the wizard's and holds nothing else.
 */
export function saveBootstrapFile(values, { dir = bootstrapDir(), env = process.env } = {}) {
  const clean = {};
  for (const key of BOOTSTRAP_MONGO_KEYS) {
    const v = values?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') clean[key] = String(v).trim();
  }
  writePrivate(path.join(dir, BOOTSTRAP_FILE), JSON.stringify(clean, null, 2) + '\n');
  applyBootstrapFile(clean, env);
  return clean;
}

/** Copy saved Mongo settings into the environment where the env is silent. */
export function applyBootstrapFile(values, env = process.env) {
  let applied = 0;
  for (const key of BOOTSTRAP_MONGO_KEYS) {
    if (values?.[key] && !env[key]) {
      env[key] = String(values[key]);
      applied++;
    }
  }
  return applied;
}

/** Is a database named by configuration (env, or the wizard's saved file)? */
export function hasMongoConfig(env = process.env) {
  return Boolean(env.MONGO_URI || env.MONGO_HOST);
}

/**
 * Try the hosts a bundled stack would provide when nothing names a database.
 * A plain TCP connect, two seconds each; the first that answers becomes
 * MONGO_HOST for this process (not persisted — it is a default, not a
 * decision). Returns the host or null.
 */
export async function probeDefaultMongoHosts({
  env = process.env,
  hosts = ['hcs-mongo', 'mongodb', 'localhost'],
  port = Number(env.MONGO_PORT) || 27017,
  timeoutMs = 2000,
  log = logger,
} = {}) {
  const net = await import('node:net');
  for (const host of hosts) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (result) => { try { socket.destroy(); } catch (_) { /* closed */ } resolve(result); };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (ok) {
      env.MONGO_HOST = host;
      log.info(`[bootstrap] No MONGO_HOST configured — ${host}:${port} answers, using it.`);
      return host;
    }
  }
  return null;
}

export default {
  bootstrapDir,
  generateSecret,
  ensureEncryptionKey,
  ensureSessionSecret,
  readBootstrapFile,
  saveBootstrapFile,
  applyBootstrapFile,
  hasMongoConfig,
  probeDefaultMongoHosts,
  ENCRYPTION_KEY_FILE,
  BOOTSTRAP_FILE,
  BOOTSTRAP_MONGO_KEYS,
  SESSION_SECRET_DOC_KEY,
};
