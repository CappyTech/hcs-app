import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';
import ropa from '../mongoose/config/ropaConfig.js';
import tiles from '../mongoose/config/dashboardTilesConfig.js';

/**
 * Config-consistency checks for the mail filtering log. No database, no HTTP.
 *
 * Two properties are pinned here, both of which are enforced by absence and so
 * would otherwise regress silently:
 *
 *  1. The module is read-only. It has no write path, and that is the whole
 *     guarantee — a POST route appearing in mailRoutes.js would quietly turn a
 *     viewer into an editor of an audit record.
 *  2. The processing is on the Article 30 register. This is the widest
 *     category of personal data the platform touches — anyone who emails the
 *     business — and the register entry is the thing that makes holding it
 *     defensible.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Source with comments removed, so assertions match code and not prose. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const routesSrc = read('mongoose/routes/mailRoutes.js');
const controllerSrc = read('mongoose/controllers/mailFilterController.js');
const serviceSrc = read('mongoose/services/mailFilterLogService.js');
const appSrc = read('app.js');

describe('mail routes — read-only by absence', () => {
  it('registers only GET routes', () => {
    const verbs = [...routesSrc.matchAll(/router\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(verbs.length >= 2, `expected at least 2 routes, found ${verbs.length}`);
    for (const verb of verbs) {
      assert.equal(verb, 'get', `mailRoutes.js registers a ${verb.toUpperCase()} route; this module must stay read-only`);
    }
  });

  it('registers the expected surface', () => {
    const paths = [...routesSrc.matchAll(/router\.get\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(paths.sort(), ['/mail', '/mail/message/:id']);
  });

  it('guards every route with admin', () => {
    const guards = [...routesSrc.matchAll(/router\.get\([^)]*\.\.\.(\w+)/g)].map((m) => m[1]);
    assert.equal(guards.length, 2);
    assert.ok(guards.every((g) => g === 'mailGuard'), 'every route must use the shared guard');
    assert.match(routesSrc, /ensureRole\('admin'\)/);
    assert.match(routesSrc, /ensureAuthenticated/);
  });

  it('is mounted in app.js', () => {
    assert.match(appSrc, /import __mailRoutes from '\.\/mongoose\/routes\/mailRoutes\.js';/);
    assert.match(appSrc, /appRouter\.use\('\/', __mailRoutes\);/);
  });
});

describe('mail routes — permissions registry', () => {
  it("lists '/mail' in routeAccess as admin only", () => {
    assert.deepEqual(rbac.routeAccess['/mail'], ['admin']);
  });

  it('agrees with the guard in the route file', () => {
    // The two layers disagreeing silently is the failure worth catching: the
    // middleware would allow a role the route then refuses, or the reverse.
    const declared = rbac.routeAccess['/mail'];
    assert.ok(declared.includes('admin'));
    assert.equal(declared.length, 1, 'widening this is a decision about third-party personal data');
  });

  it('does not register sub-paths that literal prefix matching would never hit', () => {
    // matchRoutePattern has no :param support, so '/mail/message/:id' as a
    // routeAccess key would read as protection that does not exist.
    const mailKeys = Object.keys(rbac.routeAccess).filter((k) => k.startsWith('/mail'));
    assert.deepEqual(mailKeys, ['/mail']);
  });

  it('exposes a dashboard tile pointing at the module', () => {
    const tile = Object.values(tiles).find((t) => t && t.link === '/mail');
    assert.ok(tile, 'no dashboard tile links to /mail');
    assert.deepEqual(tile.department, ['admin']);
  });
});

describe('mail filtering log — data handling', () => {
  it('is on the Article 30 register', () => {
    const activity = ropa.activities.find((a) => /mail filtering/i.test(a.name));
    assert.ok(activity, 'inbound mail filtering is not recorded in ropaConfig');
    assert.equal(activity.retention.startsWith('90 days'), true);
    assert.ok(activity.lawfulBasis.includes('legitimate_interests'));
    // The point of the entry: the subject category is anyone who writes to us,
    // not just people we already hold records for.
    assert.ok(
      activity.subjectCategories.includes('any_inbound_correspondent'),
      'the register must record that this covers arbitrary third parties',
    );
  });

  it('names the filtering provider as a processor', () => {
    const proc = ropa.processors.find((p) => /spamexperts|strikemail/i.test(p.name));
    assert.ok(proc, 'the mail filtering provider is not listed as a processor');
  });

  it('never copies the log into Mongo', () => {
    // Mongo is dumped nightly with its own 90-day archive retention, so
    // ingesting these records would keep copies alive for ~180 days against a
    // 90-day policy and take the host deletion job out of the critical path.
    //
    // Comments are stripped first: both files explain this decision in prose,
    // and matching the explanation instead of the code would fail the moment
    // someone documented it properly.
    for (const [name, src] of [['service', serviceSrc], ['controller', controllerSrc]]) {
      const code = stripComments(src);
      assert.doesNotMatch(code, /mongooseDatabaseService|\bmdb\b|from ['"]mongoose['"]/,
        `the ${name} must not touch the database`);
    }
  });

  it('never builds a RegExp from user input', () => {
    assert.doesNotMatch(stripComments(serviceSrc), /new RegExp/,
      'user input compiled into a pattern is a ReDoS vector');
  });

  it('caps the search window at the collector retention period', async () => {
    const log = (await import('../mongoose/services/mailFilterLogService.js')).default;
    assert.equal(log.MAX_DAYS, 90);
  });
});
