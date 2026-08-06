import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';

/**
 * `rbac.canAccess` returns `{ allowed, ownOnly }`, so using its return value as
 * a bare boolean is *always true*. Every consumer destructures `.allowed`
 * except, for a while, the two dashboard filters in indexController — which
 * meant a department showed its whole tile list to any role that could open it.
 *
 * It never became a permission bypass, because the list and CRUD routes carry
 * their own guards; it made the dashboards advertise links that answer 403.
 * That is exactly the kind of fault that reappears, because the broken form
 * reads perfectly naturally.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexControllerSrc = fs.readFileSync(
  path.join(ROOT, 'mongoose/controllers/indexController.js'), 'utf8',
);

describe('dashboard tile role filtering', () => {
  it('canAccess returns an object, so a bare call is always truthy', () => {
    const denied = rbac.canAccess('auditor', 'invoice', 'l');
    assert.equal(typeof denied, 'object');
    assert.equal(denied.allowed, false);
    // The trap, stated as an assertion: this is why `.allowed` is required.
    assert.ok(denied, 'a denied result is still truthy as an object');
  });

  it('indexController never uses canAccess as a bare boolean', () => {
    const calls = indexControllerSrc.match(/rbac\.canAccess\([^)]*\)(\.allowed)?/g) || [];
    assert.ok(calls.length >= 2, `expected the dashboard filters, found ${calls.length}`);
    for (const call of calls) {
      assert.ok(
        call.endsWith('.allowed'),
        `"${call}" reads canAccess as a boolean; it returns { allowed, ownOnly }`,
      );
    }
  });

  it('a role with no model grants can list nothing', () => {
    // The auditor role added in 6.22.0 has no roleModelAccess entry at all.
    assert.deepEqual(rbac.getListableModels('auditor'), []);
    for (const model of ['user', 'invoice', 'employee', 'vehicle', 'attendance']) {
      assert.equal(
        rbac.canAccess('auditor', model, 'l').allowed, false,
        `auditor should not be able to list ${model}`,
      );
    }
  });
});
