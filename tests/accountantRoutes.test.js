import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';

/**
 * The accountant portal is read-only. That property is worth a test rather
 * than a comment, because it is enforced by an absence — no POST is
 * registered — and an absence is exactly the kind of thing a later edit
 * removes without noticing.
 *
 * Config-only: no database, no HTTP.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesSrc = fs.readFileSync(path.join(ROOT, 'mongoose/routes/accountantRoutes.js'), 'utf8');
const controllerSrc = fs.readFileSync(path.join(ROOT, 'mongoose/controllers/accountantController.js'), 'utf8');

describe('accountant portal / read-only', () => {
  it('registers no write route of any kind', () => {
    // Any express verb that changes state. The router is allowed exactly one
    // verb, and it is not one of these.
    for (const verb of ['post', 'put', 'patch', 'delete']) {
      assert.equal(
        new RegExp(`router\\.${verb}\\(`).test(routesSrc),
        false,
        `accountantRoutes.js registers a ${verb.toUpperCase()} — the portal must stay read-only`,
      );
    }
  });

  it('registers the expected pages, all as GET', () => {
    const re = /router\.get\(\s*'([^']+)'\s*,\s*\.\.\.(\w+)/g;
    const found = [];
    let m;
    while ((m = re.exec(routesSrc)) !== null) found.push({ path: m[1], guard: m[2] });

    for (const expected of [
      '/accountant',
      '/accountant/queries',
      '/accountant/signoff',
      '/accountant/statements',
      '/accountant/statements/:uuid',
      '/accountant/accounts/:accountId',
      // The account is part of the line's identity: an internal transfer is
      // two ledger lines sharing one KashFlow Id.
      '/accountant/lines/:bankAccountId/:bankTransactionId',
    ]) {
      assert.ok(found.some(r => r.path === expected), `missing route ${expected}`);
    }

    // Every route behind the same guard. A page that quietly loses the
    // department check would be reachable by any authenticated user.
    for (const r of found) {
      assert.equal(r.guard, 'readGuard', `${r.path} is not behind readGuard`);
    }
  });

  it('the controller never writes', () => {
    // The portal reads through services that also serve /bank; a write here
    // would be a write to the live reconciliation from an external login.
    for (const forbidden of ['.save(', '.updateOne(', '.updateMany(', '.deleteOne(',
      '.deleteMany(', '.bulkWrite(', '.findOneAndUpdate(', '.insertMany(', '.create(']) {
      assert.equal(
        controllerSrc.includes(forbidden),
        false,
        `accountantController.js calls ${forbidden} — the portal must not write`,
      );
    }
  });
});

describe('accountant portal / access control', () => {
  it('grants the auditor role the portal and nothing else', () => {
    assert.equal(rbac.canAccessRoute('auditor', '/accountant'), true);

    // The write half of the module. '/bank' is a longer, more specific prefix,
    // so a request to /bank matches it and the auditor is refused there.
    assert.equal(rbac.canAccessRoute('auditor', '/bank'), false);
  });

  it('routes /bank and /accountant to different patterns', () => {
    assert.equal(rbac.matchRoutePattern('/bank/accounts/611594'), '/bank');
    assert.equal(rbac.matchRoutePattern('/accountant/accounts/611594'), '/accountant');
    assert.equal(rbac.matchRoutePattern('/accountant'), '/accountant');
  });

  it('gives the auditor no CRUD model access at all', () => {
    // The absence of a roleModelAccess entry is what keeps an external login
    // off every generic /:model/read/:uuid route in the app.
    assert.deepEqual(rbac.getListableModels('auditor'), []);
  });

  it('does not widen the finance department', () => {
    // ensureDepartment('finance') would hand the auditor the finance dashboard
    // and every KashFlow tile on it. The portal has its own department.
    assert.equal(departmentsConfig.finance.roles.includes('auditor'), false);
    assert.equal(departmentsConfig['accountant-portal'].roles.includes('auditor'), true);
    assert.equal(rbac.canAccessDepartment('auditor', 'accountant-portal'), true);
    assert.equal(rbac.canAccessDepartment('auditor', 'finance'), false);
  });

  it('keeps the internal finance roles able to see the portal', () => {
    // A portal nobody in-house can open is a portal nobody in-house can support.
    for (const role of ['admin', 'accountant']) {
      assert.equal(rbac.canAccessRoute(role, '/accountant'), true, `${role} cannot open the portal`);
      assert.equal(rbac.canAccessDepartment(role, 'accountant-portal'), true);
    }
  });
});
