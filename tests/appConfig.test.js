import { describe, it, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Managed configuration: the registry that decides what is configurable, and
 * the precedence that decides whether saving it does anything.
 *
 * The env values below are set before configService is imported, because it
 * snapshots process.env at module load — that snapshot is what "revert to the
 * environment" restores.
 */
process.env.PAPERLESS_ACCEPT = 'application/json; version=6';
process.env.SMTP_HOST = 'smtp.example.test';
delete process.env.HCS_SYNC_TIMEOUT_MS;

const registry = (await import('../services/configRegistry.js')).default;
const configService = (await import('../services/configService.js')).default;
const configStore = (await import('../services/configStoreService.js')).default;

describe('configRegistry', () => {
  it('covers every key exactly once and never a bootstrap key', () => {
    // Both are enforced at import time; this pins the guard itself, since a
    // duplicate would otherwise silently win depending on group order.
    const seen = new Set();
    for (const group of registry.GROUPS) {
      for (const entry of group.keys) {
        assert.ok(!seen.has(entry.key), `${entry.key} appears twice`);
        seen.add(entry.key);
        assert.ok(!registry.BOOTSTRAP_KEYS.includes(entry.key), `${entry.key} is a bootstrap key`);
      }
    }
  });

  it('gives every key something an admin can read', () => {
    for (const key of registry.managedKeys()) {
      const entry = registry.findKey(key);
      assert.ok(entry.label, `${key} has no label`);
      assert.ok(entry.help, `${key} has no help text`);
      assert.match(entry.type, /^(text|number|boolean|secret|textarea)$/, `${key} has an unknown type`);
    }
  });

  it('marks the keys that are read at import time as restart-required', () => {
    // These are evaluated before Mongo is connected, so a save cannot reach
    // them. Saying nothing would make the save look like it worked.
    for (const key of ['BLOCKED_IPS', 'AUDIT_TTL_DAYS', 'ENABLE_HSTS', 'PAPERLESS_CF_CACHE_MS']) {
      assert.equal(registry.findKey(key)?.restart, true, `${key} should be restart-required`);
    }
    assert.notEqual(registry.findKey('TRUST_EDGE_TLS')?.restart, true, 'TRUST_EDGE_TLS is read per request');
  });

  it('treats every credential as a secret', () => {
    for (const key of registry.managedKeys()) {
      if (/PASSWORD|TOKEN|SECRET|_PASS$|API_KEY|MEMORABLE/.test(key)) {
        assert.ok(registry.isSecret(key), `${key} must be stored encrypted and never rendered`);
      }
    }
  });
});

describe('configService precedence', () => {
  beforeEach(() => {
    configService.setManagedSnapshot(new Map());
  });

  it('prefers a managed value over the environment', () => {
    assert.equal(configService.get('PAPERLESS_ACCEPT'), 'application/json; version=6');
    configService.setManagedSnapshot(new Map([['PAPERLESS_ACCEPT', 'application/json; version=10']]));
    assert.equal(configService.get('PAPERLESS_ACCEPT'), 'application/json; version=10');
  });

  it('ignores a blank managed value rather than blanking the setting', () => {
    configService.setManagedSnapshot(new Map([['SMTP_HOST', '']]));
    assert.equal(configService.get('SMTP_HOST'), 'smtp.example.test');
  });

  it('reports where a value came from', () => {
    assert.equal(configService.sourceOf('SMTP_HOST'), 'env');
    assert.equal(configService.sourceOf('HCS_SYNC_TIMEOUT_MS'), 'default');
    configService.setManagedSnapshot(new Map([['SMTP_HOST', 'smtp.managed.test']]));
    assert.equal(configService.sourceOf('SMTP_HOST'), 'store');
  });

  it('remembers the startup environment even after the store overrides it', () => {
    configService.setManagedSnapshot(new Map([['SMTP_HOST', 'smtp.managed.test']]));
    process.env.SMTP_HOST = 'smtp.managed.test';
    assert.equal(configService.startupEnvValue('SMTP_HOST'), 'smtp.example.test');
    process.env.SMTP_HOST = 'smtp.example.test';
  });
});

describe('configStore.applySnapshot', () => {
  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.example.test';
    delete process.env.HCS_SYNC_TIMEOUT_MS;
  });

  it('writes managed values into process.env for the direct readers', () => {
    // 122 call sites read process.env directly; this is what lets a saved value
    // reach them without touching any of them.
    configStore.applySnapshot(new Map([['SMTP_HOST', 'smtp.managed.test']]));
    assert.equal(process.env.SMTP_HOST, 'smtp.managed.test');
  });

  it('restores the startup environment value when a key is reverted', () => {
    configStore.applySnapshot(new Map([['SMTP_HOST', 'smtp.managed.test']]));
    configStore.applySnapshot(new Map());
    assert.equal(process.env.SMTP_HOST, 'smtp.example.test');
  });

  it('deletes rather than blanks a key the environment never set', () => {
    // '' reads as "set but empty" to plenty of callers, which is not the same
    // as unset — `parseInt('') || 20000` and `process.env.X ? … : …` disagree.
    configStore.applySnapshot(new Map([['HCS_SYNC_TIMEOUT_MS', '5000']]));
    assert.equal(process.env.HCS_SYNC_TIMEOUT_MS, '5000');
    configStore.applySnapshot(new Map());
    assert.equal('HCS_SYNC_TIMEOUT_MS' in process.env, false);
  });
});

describe('settings routes', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'mongoose/routes/settingsRoutes.js'), 'utf8');

  it('serves every group through one generic route', () => {
    assert.match(routes, /router\.get\('\/admin\/config\/:group'/);
    assert.match(routes, /router\.post\('\/admin\/config\/:group'/);
  });

  it('keeps the old per-service URLs working', () => {
    // They are in bookmarks and in the admin menu; a 404 on a settings page
    // reads as the feature having been removed.
    for (const legacy of ['kashflow', 'smtp', 'paperless', 'sms']) {
      assert.match(routes, new RegExp(`${legacy}: '${legacy}'`));
    }
    assert.match(routes, /res\.redirect\(307, `\/admin\/config\/\$\{group\}`\)/);
  });

  it('guards every configuration route with the admin role', () => {
    const configRoutes = routes.split('\n').filter((l) => l.includes("'/admin/config"));
    assert.ok(configRoutes.length >= 5);
    for (const line of configRoutes) {
      assert.match(line, /ensureRoles\('admin'\)/, `unguarded: ${line.trim()}`);
    }
  });
});
