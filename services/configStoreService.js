/**
 * configStoreService — the Mongo-backed managed configuration store.
 *
 * This is what makes a setting changeable without a redeploy. It holds the
 * values an admin has taken ownership of, and it wins over compose.env (see the
 * priority note in configService).
 *
 * Two things it does that are easy to miss:
 *
 * 1. **It writes managed values into `process.env`.** 122 places read
 *    `process.env.X` directly rather than going through configService, and
 *    rewriting them all would be a far riskier change than this one. Applying
 *    the store to the environment means every existing reader picks up a saved
 *    value with no call-site changes.
 *
 * 2. **It cannot help the ~14 keys that are read at import time.** Those are
 *    evaluated before Mongo is even connected, so a save cannot reach them
 *    until the container restarts. configRegistry marks them `restart: true`
 *    and the UI says so — a setting that silently does nothing is worse than
 *    one that admits it needs a restart.
 *
 * Secrets are encrypted with encryptionService before they are stored, so the
 * audit trail records that a secret changed without recording the secret.
 */

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import configService from './configService.js';
import registry from './configRegistry.js';
import logger from './loggerService.js';

// encryptionService throws at import when ENCRYPTION_KEY is unset, which is
// correct for it and wrong here: this module is imported by the settings UI and
// by tests that never touch a secret. Load it on first use instead.
let _encryption = null;
async function encryption() {
  if (!_encryption) _encryption = await import('./encryptionService.js');
  return _encryption;
}

const SECRET_PREFIX = 'enc:';

function model() {
  const AppConfig = mdb.INTERNAL && mdb.INTERNAL.appConfig;
  if (!AppConfig) throw new Error('configStoreService: INTERNAL.appConfig model is not available');
  return AppConfig;
}

function assertManaged(key) {
  if (registry.BOOTSTRAP_KEYS.includes(key)) {
    throw new Error(`${key} is a bootstrap setting and cannot be stored — it is needed before the store can be read.`);
  }
  if (!registry.isManaged(key)) {
    throw new Error(`${key} is not in configRegistry, so it cannot be managed.`);
  }
}

async function encodeValue(key, value) {
  if (!registry.isSecret(key)) return String(value);
  const { encrypt } = await encryption();
  return SECRET_PREFIX + encrypt(String(value));
}

async function decodeValue(key, stored) {
  if (typeof stored !== 'string' || !stored.startsWith(SECRET_PREFIX)) return stored;
  try {
    const { decrypt } = await encryption();
    return decrypt(stored.slice(SECRET_PREFIX.length));
  } catch (err) {
    // A value encrypted under a different ENCRYPTION_KEY cannot be recovered.
    // Report it rather than handing the caller ciphertext that would fail in
    // some unrelated place later.
    logger.error(`[configStore] could not decrypt ${key}: ${err.message}`);
    return '';
  }
}

/**
 * Push a snapshot into configService and process.env. Exported because it is
 * the whole of the precedence inversion — everything else here is storage — and
 * it is the part that has to be right for a key reverted out of the store to go
 * back to what compose.env says rather than to an empty string.
 */
function applySnapshot(snapshot) {
  configService.setManagedSnapshot(snapshot);
  for (const key of registry.managedKeys()) {
    if (snapshot.has(key) && snapshot.get(key) !== '') {
      process.env[key] = snapshot.get(key);
    } else {
      // Reverted, or never stored: fall back to whatever the environment held
      // at startup. Deleting is not the same as setting '' — an empty string
      // reads as "set but blank" to plenty of callers.
      const original = configService.startupEnvValue(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

let _snapshot = new Map();

/**
 * Load every stored value. Call once after mdb.connect(), and again is
 * harmless. Never throws: configuration that cannot be read must not stop the
 * app from starting, or a bad save would be unrecoverable through the UI.
 */
async function load() {
  try {
    const docs = await model().find({}).lean();
    const snapshot = new Map();
    for (const doc of docs) {
      if (!registry.isManaged(doc.key)) continue; // key retired from the registry
      snapshot.set(doc.key, await decodeValue(doc.key, doc.value));
    }
    _snapshot = snapshot;
    applySnapshot(snapshot);
    logger.info(`[configStore] loaded ${snapshot.size} managed setting(s)`);
    return snapshot;
  } catch (err) {
    logger.error(`[configStore] load failed, continuing on environment only: ${err.message}`);
    return _snapshot;
  }
}

/** Save one value. */
async function set(key, value, updatedBy = null) {
  assertManaged(key);
  const raw = String(value ?? '');
  await model().findOneAndUpdate(
    { key },
    { key, value: await encodeValue(key, raw), secret: registry.isSecret(key), updatedBy },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  _snapshot.set(key, raw);
  applySnapshot(_snapshot);
  return raw;
}

/** Remove a value, handing the key back to the environment. */
async function unset(key) {
  assertManaged(key);
  await model().deleteOne({ key });
  _snapshot.delete(key);
  applySnapshot(_snapshot);
}

/**
 * Copy the value a key currently gets from the environment into the store —
 * the first half of migrating a key out of compose.env. Doing it this way round
 * means the effective value never changes at the moment of adoption, so the
 * line can be removed from compose.env at the next deploy with nothing to
 * co-ordinate.
 * @returns {number} how many keys were adopted
 */
async function adoptFromEnv(keys, updatedBy = null) {
  let adopted = 0;
  for (const key of keys) {
    if (!registry.isManaged(key)) continue;
    if (_snapshot.has(key)) continue; // already ours
    const value = configService.startupEnvValue(key);
    if (value === undefined || value === '') continue;
    await set(key, value, updatedBy);
    adopted++;
  }
  return adopted;
}

/** Managed keys still supplied by compose.env — the migration's to-do list. */
function pendingEnvKeys() {
  return registry
    .managedKeys()
    .filter((key) => !_snapshot.has(key) && configService.startupEnvValue(key));
}

/**
 * Keys the store owns while compose.env also sets them. Harmless — the store
 * wins — but the env line is now dead weight and should be deleted at the next
 * deploy, so the UI and the startup log both say so.
 */
function shadowedEnvKeys() {
  return registry.managedKeys().filter((key) => _snapshot.has(key) && configService.startupEnvValue(key));
}

function has(key) {
  return _snapshot.has(key);
}

function snapshot() {
  return new Map(_snapshot);
}

/** Log the state of the migration at startup. */
function logMigrationState() {
  const pending = pendingEnvKeys();
  const shadowed = shadowedEnvKeys();
  logger.info(
    `[configStore] ${_snapshot.size} managed, ${pending.length} still from compose.env, ${shadowed.length} shadowing a redundant compose.env line`,
  );
  if (shadowed.length) {
    logger.info(`[configStore] safe to delete from compose.env: ${shadowed.join(', ')}`);
  }
}

export default {
  applySnapshot,
  load,
  set,
  unset,
  adoptFromEnv,
  pendingEnvKeys,
  shadowedEnvKeys,
  logMigrationState,
  has,
  snapshot,
};
