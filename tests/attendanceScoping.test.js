import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';

/**
 * scopeQuery returns three different things, and two of them look alike:
 *
 *   null  – this role may not read this model at all  (caller should refuse)
 *   {}    – this role may read all of it              (caller should not filter)
 *   {...} – this role may read its own records only
 *
 * The attendance controller collapsed `null` and `{}` into "return
 * everything", so a denial produced the same output as unrestricted access.
 * Nothing exploited it, because every role that could reach /daily already
 * held an attendance grant — but that was a property of the route guard, not
 * of the scoping, and the guard has now been widened.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const controllerSrc = fs.readFileSync(
  path.join(ROOT, 'mongoose/controllers/attendanceController.js'), 'utf8',
);
const routesSrc = fs.readFileSync(
  path.join(ROOT, 'mongoose/routes/attendanceRoutes.js'), 'utf8',
);

describe('attendance scoping', () => {
  it('never treats a null (denied) scope as unrestricted', () => {
    // The exact shape that conflated them. `!filter` is true for null AND for
    // any empty-ish value, which is what made the denial invisible.
    assert.equal(
      /if\s*\(\s*!filter\s*\|\|\s*Object\.keys\(filter\)\.length === 0\s*\)\s*return records/.test(controllerSrc),
      false,
      'filterAttendanceForUser is treating a denied scope as unrestricted again',
    );
    assert.ok(
      controllerSrc.includes('if (filter === null) return [];'),
      'filterAttendanceForUser should return nothing when the scope is a denial',
    );
  });

  it('the weekly view distinguishes denial from unrestricted too', () => {
    assert.equal(
      /if\s*\(\s*filter\s*&&\s*Object\.keys\(filter\)\.length > 0\s*\)/.test(controllerSrc),
      false,
      'the weekly scoping block silently skips filtering on a denied scope',
    );
  });
});

describe('accountant attendance access', () => {
  it('is granted unscoped read, matching what payroll needs', () => {
    const { allowed, ownOnly } = rbac.canAccess('accountant', 'attendance', 'r');
    assert.equal(allowed, true, 'accountant should be able to read attendance');
    assert.equal(ownOnly, false, 'payroll needs everyone, not the accountant\'s own records');
  });

  it('is admitted by both the route guard and routeAccess', () => {
    // Two independent layers; a role in one and not the other either 403s at
    // the guard or is refused by ensureRouteAccess before reaching it.
    for (const p of ['/daily', '/weekly']) {
      assert.equal(rbac.canAccessRoute('accountant', p), true, `routeAccess omits accountant for ${p}`);
    }
    const guards = routesSrc.match(/ensureRoles\([^)]*\)/g) || [];
    const attendanceViews = guards.filter(g => g.includes('employee') && g.includes('subcontractor'));
    assert.ok(attendanceViews.length >= 2, 'expected the daily and weekly guards');
    for (const g of attendanceViews.slice(0, 2)) {
      assert.ok(g.includes('accountant'), `route guard omits accountant: ${g}`);
    }
  });

  it('does not accidentally widen anyone else', () => {
    // client, hmrc and auditor have no business in attendance.
    for (const role of ['client', 'hmrc', 'auditor']) {
      assert.equal(
        rbac.canAccess(role, 'attendance', 'r').allowed, false,
        `${role} should not be able to read attendance`,
      );
      assert.equal(rbac.canAccessRoute(role, '/daily'), false, `${role} should not reach /daily`);
    }
    // employee and subcontractor keep their own-records-only scoping.
    for (const role of ['employee', 'subcontractor']) {
      const { allowed, ownOnly } = rbac.canAccess(role, 'attendance', 'r');
      assert.equal(allowed, true);
      assert.equal(ownOnly, true, `${role} must stay scoped to their own records`);
    }
  });
});
