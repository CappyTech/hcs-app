import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/generate-sitemap.mjs loads every router, so it runs in its own
 * process (route modules start timers) and writes to a temp folder.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/generate-sitemap.mjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
}

describe('sitemap generator', () => {
  let sitemap;
  const find = (method, p) => sitemap.routes.find((r) => r.method === method && r.path === p);

  before(() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hcs-sitemap-'));
    const result = run(['--out', out]);
    assert.equal(result.status, 0, result.stderr);
    sitemap = JSON.parse(fs.readFileSync(path.join(out, 'sitemap.json'), 'utf8'));
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('includes the generated CRUD and list routes', () => {
    // These only exist once models are registered, which is the part most
    // likely to break silently and leave the sitemap missing half the app.
    assert.ok(find('GET', '/employees'), 'list route missing');
    assert.ok(find('GET', '/employee/read/:uuid'), 'CRUD read route missing');
    assert.ok(find('POST', '/employee/:uuid'), 'CRUD update route missing');
  });

  it('marks public pages public', () => {
    assert.equal(find('GET', '/user/login').access, 'public');
    assert.equal(find('GET', '/legal/terms').access, 'public');
  });

  it('resolves per-route role guards', () => {
    assert.deepEqual(find('GET', '/admin').roles, ['admin']);
    const bank = find('GET', '/bank');
    assert.ok(bank.roles.includes('accountant'));
    assert.ok(!bank.roles.includes('employee'));
  });

  it('applies the global routeAccess table', () => {
    // cisRoutes has no per-route role guard; only routeAccess limits it.
    assert.deepEqual(find('GET', '/CIS/Dashboard/:year/:month').roles.sort(), ['accountant', 'admin', 'hmrc']);
  });

  it('mounts the dev and setup routers at their prefixes, outside the login guard', () => {
    const db = find('GET', '/admin/db');
    assert.equal(db.access, 'public');
    assert.match(db.condition, /Development only/);
    assert.match(find('GET', '/setup').condition, /First run only/);
  });

  it('has no route declared twice', () => {
    assert.deepEqual(sitemap.warnings.filter((w) => /declared in both/.test(w)), []);
  });

  it('matches the committed docs/SITEMAP.md and docs/sitemap.json', () => {
    const result = run(['--check']);
    assert.equal(result.status, 0, `${result.stderr}Run npm run sitemap and commit the result.`);
  });
});
