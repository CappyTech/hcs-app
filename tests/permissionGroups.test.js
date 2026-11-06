import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import authService from '../services/authService.js';
import { parseRoles } from '../mongoose/controllers/userRolesController.js';

const LEGACY = ['none', 'admin', 'accountant', 'employee', 'subcontractor', 'client', 'hmrc', 'auditor'];

// Run one middleware; resolve with the error passed to next() (undefined = allowed).
function run(mw, user, path = '/') {
  return new Promise((resolve) => {
    mw({ user, path, originalUrl: path }, {}, (err) => resolve(err));
  });
}

describe('accessGroupsConfig', () => {
  it('every grant names a real group and level', () => {
    for (const [slug, def] of Object.entries(accessGroups.jobRoles)) {
      for (const g of def.grants) {
        assert.ok(accessGroups.groups[g.group], `${slug} → unknown group ${g.group}`);
        assert.ok(accessGroups.LEVELS.includes(g.level), `${slug} → unknown level ${g.level}`);
        assert.ok(accessGroups.SCOPES.includes(g.scope || 'all'), `${slug} → unknown scope ${g.scope}`);
      }
    }
  });

  it('job role slugs never collide with a legacy role', () => {
    for (const slug of accessGroups.JOB_ROLE_SLUGS) assert.ok(!LEGACY.includes(slug), slug);
  });

  it('every group department exists in departmentsConfig', () => {
    for (const [name, group] of Object.entries(accessGroups.groups)) {
      for (const d of group.departments) assert.ok(departmentsConfig[d], `${name} → ${d}`);
    }
  });

  it('every group route resolves to at least one routeAccess key', () => {
    const keys = Object.keys(rbac.routeAccess);
    for (const [name, group] of Object.entries(accessGroups.groups)) {
      for (const list of Object.values(group.routes || {})) {
        for (const key of list) {
          const hit = key.endsWith('*')
            ? keys.some((k) => k.startsWith(key.slice(0, -1)))
            : keys.includes(key);
          assert.ok(hit, `${name} → ${key} matches no routeAccess entry`);
        }
      }
    }
  });

  it('roles with a project-scoped grant are not available yet', () => {
    assert.equal(accessGroups.isJobRoleAvailable('siteManager'), false);
    assert.equal(accessGroups.isJobRoleAvailable('supervisor'), false);
    assert.equal(accessGroups.isJobRoleAvailable('contractsManager'), true);
    assert.ok(!rbac.JOB_ROLES.has('siteManager'));
  });
});

describe('compiled job roles', () => {
  it('Contracts Manager gets site ops + commercial, not finance or payroll', () => {
    const depts = rbac.roleDepartments.contractsManager;
    assert.ok(depts.includes('management'));
    assert.ok(depts.includes('attendance'));
    assert.ok(!depts.includes('finance'));
    assert.ok(!depts.includes('payroll'));
    assert.equal(rbac.canAccess('contractsManager', 'assignment', 'u').allowed, true);
    assert.equal(rbac.canAccess('contractsManager', 'employee', 'r').allowed, false);
    assert.equal(rbac.canAccess('contractsManager', 'user', 'r').allowed, false);
  });

  it('REST and bank models are never writable through a group', () => {
    for (const slug of accessGroups.JOB_ROLE_SLUGS) {
      for (const model of accessGroups.READ_ONLY_MODELS) {
        for (const op of ['c', 'u', 'd']) {
          assert.equal(rbac.canAccess(slug, model, op).allowed, false, `${slug} ${op} ${model}`);
        }
      }
    }
  });

  it('project-scoped grants compile to nothing', () => {
    assert.deepEqual(rbac.roleModelAccess.siteManager, {});
    assert.deepEqual(rbac.roleDepartments.siteManager, ['user']);
  });

  it('no job role reaches bank, payments or the user admin', () => {
    for (const key of ['/bank', '/payments', '/mail', '/admin/config', '/logs']) {
      const allowed = rbac.routeAccess[key];
      for (const slug of accessGroups.JOB_ROLE_SLUGS) {
        assert.ok(!(Array.isArray(allowed) && allowed.includes(slug)), `${slug} on ${key}`);
      }
    }
  });

  it('CIS returns need approve; view only sees verification', () => {
    assert.ok(!rbac.canAccessRoute('contractsManager', '/CIS/returns'));
    assert.ok(rbac.canAccessRoute('contractsManager', '/overview/subcontractors'));
    assert.ok(rbac.canAccessRoute('director', '/CIS/returns'));
  });

  it('does not mutate departmentsConfig role lists', () => {
    for (const dept of Object.values(departmentsConfig)) {
      for (const r of dept.roles) assert.ok(LEGACY.includes(r) || r === 'public', `${r} leaked into departmentsConfig`);
    }
  });
});

describe('rolesOf / multi-role helpers', () => {
  it('ignores legacy, unknown and unavailable roles in roles[]', () => {
    assert.deepEqual(
      rbac.rolesOf({ role: 'employee', roles: ['admin', 'contractsManager', 'siteManager', 'bogus'] }),
      ['employee', 'contractsManager'],
    );
    assert.deepEqual(rbac.rolesOf({ role: 'employee' }), ['employee']);
    assert.deepEqual(rbac.rolesOf(null), []);
  });

  it('an unscoped job role grant lifts own-only scoping', () => {
    assert.deepEqual(rbac.canAccess(['employee'], 'attendance', 'r'),
      { allowed: true, ownOnly: true, ownRole: 'employee' });
    assert.deepEqual(rbac.canAccess(['employee', 'contractsManager'], 'attendance', 'r'),
      { allowed: true, ownOnly: false });
  });

  it('single-role calls behave as before', () => {
    assert.deepEqual(rbac.canAccess('accountant', 'invoice', 'r'), { allowed: true, ownOnly: false });
    assert.deepEqual(rbac.canAccess('accountant', 'invoice', 'u'), { allowed: false, ownOnly: false });
    assert.equal(rbac.canAccessDepartment('accountant', 'finance'), true);
    assert.equal(rbac.canAccessDepartment('employee', 'finance'), false);
  });

  it('departments are the union across roles', () => {
    const depts = rbac.getDepartmentsForRole(['employee', 'fleetManager']);
    assert.ok(depts.includes('attendance'));
    assert.ok(depts.includes('maintenance'));
  });

  it('mergedModelAccess prefers the unscoped grant', () => {
    const merged = rbac.mergedModelAccess(['employee', 'contractsManager']);
    assert.ok(!merged.attendance.includes('r:own'));
    assert.ok(merged.attendance.split(',').includes('r'));
  });
});

describe('authService with job roles', () => {
  const cm = { role: 'employee', roles: ['contractsManager'] };

  it('an admin-only guard stays admin-only without an explicit grant', async () => {
    const err = await run(authService.ensureRole('admin'), cm, '/overview/project');
    assert.equal(err?.statusCode, 403);
  });

  it('a model grant opens the generic CRUD/list route', async () => {
    const mw = authService.ensureRolesOrGrant(['admin'], { model: 'assignment', operation: 'l' });
    assert.equal(await run(mw, cm, '/assignments'), undefined);
    const denied = authService.ensureRolesOrGrant(['admin'], { model: 'employee', operation: 'l' });
    assert.equal((await run(denied, cm, '/employees'))?.statusCode, 403);
  });

  it('a department grant opens that dashboard only', async () => {
    const mgmt = authService.ensureRolesOrGrant(['admin'], { department: 'management' });
    assert.equal(await run(mgmt, cm, '/management'), undefined);
    const hr = authService.ensureRolesOrGrant(['admin'], { department: 'human-resources' });
    assert.equal((await run(hr, cm, '/human-resources'))?.statusCode, 403);
  });

  it('a multi-role guard admits a job role through routeAccess', async () => {
    const mw = authService.ensureRoles('admin', 'accountant', 'employee', 'subcontractor');
    assert.equal(await run(mw, cm, '/weekly'), undefined);
  });

  it('bank stays closed to the Director', async () => {
    const director = { role: 'employee', roles: ['director'] };
    const err = await run(authService.ensureRoles('admin', 'accountant'), director, '/bank');
    assert.equal(err?.statusCode, 403);
  });

  it('primary roles are unaffected', async () => {
    assert.equal(await run(authService.ensureRole('admin'), { role: 'admin' }, '/x'), undefined);
    assert.equal((await run(authService.ensureRole('admin'), { role: 'employee' }, '/x'))?.statusCode, 403);
  });

  it('job roles require 2FA', () => {
    assert.equal(authService.roleRequiring2FA(cm), 'contractsManager');
    assert.equal(authService.roleRequiring2FA({ role: 'employee' }), null);
  });
});

describe('userRolesController.parseRoles', () => {
  it('keeps only available job roles', () => {
    assert.deepEqual(parseRoles(['director', 'admin', 'siteManager', 'director']), ['director']);
    assert.deepEqual(parseRoles('fleetManager'), ['fleetManager']);
    assert.deepEqual(parseRoles(undefined), []);
  });
});

describe('canSeeValues', () => {
  it('admin and accountant always see values; a bare employee does not', () => {
    assert.equal(rbac.canSeeValues({ role: 'admin' }), true);
    assert.equal(rbac.canSeeValues({ role: 'accountant' }), true);
    assert.equal(rbac.canSeeValues({ role: 'employee' }), false);
    assert.equal(rbac.canSeeValues(null), false);
  });

  it("follows each job role's fixed rule, ignoring the flag", () => {
    assert.equal(rbac.canSeeValues({ role: 'employee', roles: ['contractsManager'] }), true);
    assert.equal(rbac.canSeeValues({ role: 'employee', roles: ['officeManager'], canSeeValues: true }), false);
  });

  it("every job role declares a values rule; only Site Manager and Supervisor use the flag", () => {
    const flag = Object.entries(accessGroups.jobRoles).filter(([, d]) => d.values === 'flag').map(([s]) => s);
    assert.deepEqual(flag.sort(), ['siteManager', 'supervisor']);
  });

  it('a flag role resolves to its +values build only when ticked', () => {
    // Site Manager isn't assignable until project scoping lands; make it so
    // for this test only.
    rbac.JOB_ROLES.add('siteManager');
    try {
      assert.deepEqual(rbac.rolesOf({ role: 'employee', roles: ['siteManager'] }), ['employee', 'siteManager']);
      assert.deepEqual(rbac.rolesOf({ role: 'employee', roles: ['siteManager'], canSeeValues: true }), ['employee', 'siteManager+values']);
      assert.equal(rbac.canSeeValues({ role: 'employee', roles: ['siteManager'] }), false);
      assert.equal(rbac.canSeeValues({ role: 'employee', roles: ['siteManager'], canSeeValues: true }), true);
      assert.deepEqual(rbac.jobRolesOf({ role: 'employee', roles: ['siteManager'], canSeeValues: true }), ['siteManager+values']);
    } finally {
      rbac.JOB_ROLES.delete('siteManager');
    }
  });

  it("values grants are left out of the plain build and kept in the +values build", () => {
    const g = accessGroups.jobRoles.siteManager.grants;
    assert.ok(g.some((x) => x.values), 'site manager has a values grant');
    assert.ok(rbac.roleModelAccess['siteManager+values']);
    assert.ok(rbac.roleModelAccess['supervisor+values']);
    assert.ok(!rbac.roleModelAccess['contractsManager+values'], 'only flag roles get a +values build');
  });

  it('parseFlag reads a ticked checkbox', async () => {
    const { parseFlag } = await import('../mongoose/controllers/userRolesController.js');
    assert.equal(parseFlag('on'), true);
    assert.equal(parseFlag(undefined), false);
    assert.equal(parseFlag('off'), false);
  });
});
