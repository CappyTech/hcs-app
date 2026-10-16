import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapDir,
  ensureEncryptionKey,
  ensureSessionSecret,
  readBootstrapFile,
  saveBootstrapFile,
  applyBootstrapFile,
  hasMongoConfig,
  ENCRYPTION_KEY_FILE,
  BOOTSTRAP_FILE,
  SESSION_SECRET_DOC_KEY,
} from '../services/bootstrapSecretsService.js';
import { envFromForm, uriFromForm } from '../mongoose/controllers/setupController.js';

const quiet = { info() {}, warn() {}, error() {} };

/**
 * The two secrets a deployment needs before it can read its own configuration
 * must come from somewhere a human never has to type them: the storage volume
 * for ENCRYPTION_KEY, Mongo for SESSION_SECRET. The environment still wins.
 */
describe('bootstrapSecretsService', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hcs-bootstrap-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('bootstrapDir', () => {
    it('lives under FILE_STORAGE_DIR, the mounted volume', () => {
      assert.equal(bootstrapDir('/app/storage'), path.join(path.resolve('/app/storage'), '.bootstrap'));
    });
    it('never resolves under config/, which is inside the image', () => {
      assert.ok(!bootstrapDir(undefined).includes(`${path.sep}config${path.sep}`));
    });
  });

  describe('ensureEncryptionKey', () => {
    it('leaves an environment value alone and writes nothing', () => {
      const env = { ENCRYPTION_KEY: 'from-env' };
      const out = ensureEncryptionKey({ env, dir: tmp, log: quiet });
      assert.deepEqual(out, { source: 'env', file: null });
      assert.equal(env.ENCRYPTION_KEY, 'from-env');
      assert.ok(!fs.existsSync(path.join(tmp, ENCRYPTION_KEY_FILE)));
    });

    it('generates a 32-byte hex key once and reads it back on the next start', () => {
      const env = {};
      const first = ensureEncryptionKey({ env, dir: tmp, log: quiet });
      assert.equal(first.source, 'generated');
      assert.equal(first.file, path.join(tmp, ENCRYPTION_KEY_FILE));
      assert.match(env.ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
      assert.equal(fs.readFileSync(first.file, 'utf8').trim(), env.ENCRYPTION_KEY);

      const env2 = {};
      const second = ensureEncryptionKey({ env: env2, dir: tmp, log: quiet });
      assert.equal(second.source, 'file');
      assert.equal(env2.ENCRYPTION_KEY, env.ENCRYPTION_KEY, 'a restart must get the same key or every stored secret is lost');
    });

    it('creates the directory and writes the key file owner-only', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
      const dir = path.join(tmp, 'nested', '.bootstrap');
      const { file } = ensureEncryptionKey({ env: {}, dir, log: quiet });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    });

    it('leaves no temp file behind', () => {
      ensureEncryptionKey({ env: {}, dir: tmp, log: quiet });
      assert.deepEqual(fs.readdirSync(tmp), [ENCRYPTION_KEY_FILE]);
    });
  });

  describe('ensureSessionSecret', () => {
    // Enough of the appConfig model for the service: one document per key.
    function fakeModel() {
      const docs = new Map();
      return {
        docs,
        findOne(filter) {
          const doc = docs.get(filter.key) || null;
          return { lean: async () => doc };
        },
        async findOneAndUpdate(filter, update) {
          docs.set(filter.key, { ...update });
          return docs.get(filter.key);
        },
      };
    }
    const enc = {
      encrypt: (s) => `enc(${s})`,
      decrypt: (s) => {
        const m = /^enc\((.*)\)$/.exec(s);
        if (!m) throw new Error('bad ciphertext');
        return m[1];
      },
    };

    it('uses the environment when set and never touches the database', async () => {
      const model = fakeModel();
      const env = { SESSION_SECRET: 'from-env' };
      assert.deepEqual(await ensureSessionSecret(model, enc, { env, log: quiet }), { source: 'env' });
      assert.equal(model.docs.size, 0);
    });

    it('generates once, stores it encrypted, and reads it back on the next start', async () => {
      const model = fakeModel();
      const env = {};
      assert.deepEqual(await ensureSessionSecret(model, enc, { env, log: quiet }), { source: 'generated' });
      assert.match(env.SESSION_SECRET, /^[0-9a-f]{64}$/);

      const stored = model.docs.get(SESSION_SECRET_DOC_KEY);
      assert.equal(stored.secret, true);
      assert.notEqual(stored.value, env.SESSION_SECRET, 'a database dump must not hand out the cookie-signing key');
      assert.equal(enc.decrypt(stored.value), env.SESSION_SECRET);

      const env2 = {};
      assert.deepEqual(await ensureSessionSecret(model, enc, { env: env2, log: quiet }), { source: 'db' });
      assert.equal(env2.SESSION_SECRET, env.SESSION_SECRET, 'sessions must survive a restart');
    });

    it('replaces a value that no longer decrypts rather than failing to start', async () => {
      const model = fakeModel();
      model.docs.set(SESSION_SECRET_DOC_KEY, { key: SESSION_SECRET_DOC_KEY, value: 'v2:garbage', secret: true });
      const env = {};
      const out = await ensureSessionSecret(model, enc, { env, log: quiet });
      assert.equal(out.source, 'generated');
      assert.match(env.SESSION_SECRET, /^[0-9a-f]{64}$/);
      assert.equal(enc.decrypt(model.docs.get(SESSION_SECRET_DOC_KEY).value), env.SESSION_SECRET);
    });

    it('round-trips through the real encryptionService', async () => {
      process.env.ENCRYPTION_KEY ||= 'test-key-for-unit-tests-only';
      const real = (await import('../services/encryptionService.js')).default;
      const model = fakeModel();
      const env = {};
      await ensureSessionSecret(model, real, { env, log: quiet });
      const env2 = {};
      await ensureSessionSecret(model, real, { env: env2, log: quiet });
      assert.equal(env2.SESSION_SECRET, env.SESSION_SECRET);
    });
  });

  describe('bootstrap.json (the database wizard\'s answers)', () => {
    it('keeps only Mongo keys, applies them where the env is silent, and reads back', () => {
      const env = { MONGO_PORT: '27018' };
      const saved = saveBootstrapFile(
        { MONGO_HOST: ' db.internal ', MONGO_PORT: '27017', MONGO_PASS: 'pw', COMPANY_NAME: 'nope', _bootstrapAdmin: { password: 'x' } },
        { dir: tmp, env },
      );
      assert.deepEqual(saved, { MONGO_HOST: 'db.internal', MONGO_PORT: '27017', MONGO_PASS: 'pw' });
      assert.equal(env.MONGO_HOST, 'db.internal');
      assert.equal(env.MONGO_PORT, '27018', 'the environment wins');
      assert.equal(fs.readdirSync(tmp).includes(BOOTSTRAP_FILE), true);
      assert.deepEqual(readBootstrapFile(tmp), saved);
      assert.ok(!('COMPANY_NAME' in readBootstrapFile(tmp)), 'nothing but the connection lives in this file');
    });

    it('reads as empty when absent or corrupt', () => {
      assert.deepEqual(readBootstrapFile(tmp), {});
      fs.writeFileSync(path.join(tmp, BOOTSTRAP_FILE), '{not json');
      assert.deepEqual(readBootstrapFile(tmp), {});
    });

    it('applyBootstrapFile reports how many keys it supplied', () => {
      const env = { MONGO_HOST: 'set' };
      assert.equal(applyBootstrapFile({ MONGO_HOST: 'x', MONGO_USER: 'u' }, env), 1);
      assert.equal(env.MONGO_HOST, 'set');
      assert.equal(env.MONGO_USER, 'u');
    });

    it('hasMongoConfig is true for a URI or a host', () => {
      assert.equal(hasMongoConfig({}), false);
      assert.equal(hasMongoConfig({ MONGO_HOST: 'h' }), true);
      assert.equal(hasMongoConfig({ MONGO_URI: 'mongodb://h' }), true);
    });
  });

  describe('setupController form mapping', () => {
    it('a URI wins over the parts', () => {
      assert.equal(uriFromForm({ mongoUri: ' mongodb://a/ ', mongoHost: 'b' }), 'mongodb://a/');
      assert.deepEqual(envFromForm({ mongoUri: 'mongodb://a/', mongoHost: 'b', mongoDbRest: 'r' }), { MONGO_URI: 'mongodb://a/', MONGO_DBNAME_REST: 'r' });
    });
    it('builds an authenticated URI from the parts', () => {
      assert.equal(uriFromForm({ mongoHost: 'h', mongoPort: '1', mongoUser: 'u@', mongoPass: 'p:w', mongoAuthSource: 'admin' }), 'mongodb://u%40:p%3Aw@h:1/?authSource=admin');
      assert.deepEqual(envFromForm({ mongoHost: 'h', mongoUser: 'u', mongoPass: 'p', mongoDbWeb: 'w' }), { MONGO_HOST: 'h', MONGO_USER: 'u', MONGO_PASS: 'p', MONGO_DBNAME_WEB: 'w' });
    });
  });
});

describe('nothing writes config/app-config.json any more', () => {
  it('configService has no save/remove and no bootstrap-admin path', async () => {
    const configService = (await import('../services/configService.js')).default;
    assert.equal(configService.save, undefined);
    assert.equal(configService.remove, undefined);
    const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
    assert.ok(!appJs.includes('_bootstrapAdmin'), 'the plaintext bootstrap password file path must stay gone');
    assert.ok(!appJs.includes('process.exit(0)'), 'the wizard must not exit the process');
  });
});
