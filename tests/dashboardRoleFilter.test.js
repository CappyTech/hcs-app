import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import customTiles from '../mongoose/config/dashboardTilesConfig.js';

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

  it('no custom tile advertises a route its department cannot open', () => {
    // The invariant: for every department, every custom tile on it, and every
    // role that may open that department, the tile's target must be reachable.
    // Two of these were live — a subcontractor was shown the CIS Dashboard and
    // Assign Subcontractors, and an admin-only department showed Submit
    // Attendance, which admins may not open.
    const offenders = [];

    for (const [slug, dept] of Object.entries(departmentsConfig)) {
      for (const tile of Object.values(customTiles)) {
        if (!tile.department?.includes(slug)) continue;

        const link = String(tile.link || '');
        if (!link.startsWith('/')) continue;              // external
        const pattern = rbac.matchRoutePattern(link);
        if (!pattern) continue;                            // uncontrolled

        for (const role of dept.roles) {
          if (role === 'public' || role === 'admin') continue;
          if (!rbac.canAccessRoute(role, pattern)) {
            offenders.push(`${slug}/${role} -> ${link}`);
          }
        }
      }
    }

    // canUseTile filters these out at render time; this asserts we know about
    // every one, so a new mismatch is a decision rather than a surprise.
    assert.deepEqual(
      offenders.sort(),
      [
        // A subcontractor's CIS department is wider than these two pages.
        'construction-industry-scheme/accountant -> /subcontractor/assign',
        'construction-industry-scheme/hmrc -> /subcontractor/assign',
        'construction-industry-scheme/subcontractor -> /CIS/Dashboard/',
        'construction-industry-scheme/subcontractor -> /subcontractor/assign',
        // The two payroll/accountant entries that used to be here are gone:
        // /daily and /weekly now admit accountants, because running payroll
        // means reading the period's attendance.
      ],
      'a custom tile points somewhere its department cannot reach',
    );
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
