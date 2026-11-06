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

describe('hasGroup', () => {
  it('admin holds every group; legacy roles hold none', () => {
    assert.equal(rbac.hasGroup({ role: 'admin' }, 'finance', 'manage'), true);
    assert.equal(rbac.hasGroup({ role: 'accountant' }, 'siteOps', 'view'), false);
    assert.equal(rbac.hasGroup({ role: 'employee' }, 'siteOps', 'view'), false);
    assert.equal(rbac.hasGroup(null, 'siteOps', 'view'), false);
  });

  it('a level includes the ones below it, not above', () => {
    const cm = { role: 'employee', roles: ['contractsManager'] };
    assert.equal(rbac.hasGroup(cm, 'siteOps', 'view'), true);
    assert.equal(rbac.hasGroup(cm, 'siteOps', 'approve'), true);
    assert.equal(rbac.hasGroup(cm, 'siteOps', 'manage'), false);
    assert.equal(rbac.hasGroup(cm, 'payroll', 'view'), false);
    const office = { role: 'employee', roles: ['officeManager'] };
    assert.equal(rbac.hasGroup(office, 'siteOps', 'view'), true);
    assert.equal(rbac.hasGroup(office, 'siteOps', 'edit'), false);
  });

  it('ignores project-scoped grants and, without the flag, values grants', () => {
    rbac.JOB_ROLES.add('siteManager');
    try {
      const sm = { role: 'employee', roles: ['siteManager'], canSeeValues: true };
      // Every Site Manager grant is project-scoped, so none counts yet.
      assert.equal(rbac.hasGroup(sm, 'siteOps', 'view'), false);
      assert.equal(rbac.hasGroup(sm, 'commercial', 'view'), false);
    } finally {
      rbac.JOB_ROLES.delete('siteManager');
    }
  });

  it('throws on an unknown group or level', () => {
    assert.throws(() => rbac.hasGroup({ role: 'admin' }, 'nope', 'view'));
    assert.throws(() => rbac.hasGroup({ role: 'admin' }, 'siteOps', 'own'));
  });
});

describe('ensureGroup', () => {
  it('admin always passes, plus the named legacy roles', async () => {
    const mw = authService.ensureGroup('siteOps', 'edit', 'accountant');
    assert.equal(await run(mw, { role: 'admin' }), undefined);
    assert.equal(await run(mw, { role: 'accountant' }), undefined);
    assert.equal((await run(mw, { role: 'employee' }))?.statusCode, 403);
  });

  it('passes a job role holding the level, refuses one below it', async () => {
    const mw = authService.ensureGroup('siteOps', 'approve');
    assert.equal(await run(mw, { role: 'employee', roles: ['contractsManager'] }), undefined);
    assert.equal(await run(mw, { role: 'employee', roles: ['director'] }), undefined);
    assert.equal((await run(mw, { role: 'employee', roles: ['officeManager'] }))?.statusCode, 403);
    assert.equal((await run(mw, { role: 'employee', roles: ['payrollHr'] }))?.statusCode, 403);
  });

  it('accepts any of several grants', async () => {
    const mw = authService.ensureGroup(
      [{ group: 'siteOps', level: 'edit' }, { group: 'payroll', level: 'view' }], null);
    assert.equal(await run(mw, { role: 'employee', roles: ['payrollHr'] }), undefined);
    assert.equal(await run(mw, { role: 'employee', roles: ['contractsManager'] }), undefined);
    assert.equal((await run(mw, { role: 'employee', roles: ['fleetManager'] }))?.statusCode, 403);
  });

  it('fails at definition time on a typo', () => {
    assert.throws(() => authService.ensureGroup('siteOp', 'view'));
  });

  it('401 without a user', async () => {
    assert.equal((await run(authService.ensureGroup('siteOps', 'view'), null))?.statusCode, 401);
  });
});

describe('ensureGroup guards agree with the global route check', async () => {
  const fs = await import('node:fs');
  const routesDir = new URL('../mongoose/routes/', import.meta.url);
  const SITE_VIEW_ROLES = ['admin', 'accountant', 'employee', 'subcontractor'];
  const routes = [];
  // router.<method>('<path>', authService.ensureGroup(<args>) — either quote style.
  const re = /router\.(get|post|put|patch|delete)\(\s*(['"])(\/[^'"]+)\2,\s*authService\.ensureGroup\(([^)]*)\)/g;
  // Files that name their guards once and reuse them:
  //   paperlessRoutes   ...docs("<level>")         → documents
  //   companyDocsRoutes view | edit | approve        → documents
  //   webRoutes         edit | approve | manage      → website
  const helpers = {
    'paperlessRoutes.js': { group: 'documents', re: /router\.(get|post|put|patch|delete)\(\s*(['"])(\/[^'"]+)\2,\s*\.\.\.docs\("(\w+)"\)/g },
    'companyDocsRoutes.js': { group: 'documents', re: /router\.(get|post|put|patch|delete)\(\s*(['"])(\/[^'"]+)\2,\s*(view|edit|approve|manage),/g },
    'webRoutes.js': { group: 'website', re: /router\.(get|post|put|patch|delete)\(\s*(['"])(\/[^'"]+)\2,\s*(view|edit|approve|manage),/g },
  };
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(file, routesDir), 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) {
      // eslint-disable-next-line no-new-func
      const args = new Function('SITE_VIEW_ROLES', `return [${m[4]}];`)(SITE_VIEW_ROLES);
      routes.push({ file, method: m[1], path: m[3], args });
    }
    const h = helpers[file];
    if (h) {
      while ((m = h.re.exec(src)) !== null) routes.push({ file, method: m[1], path: m[3], args: [h.group, m[4]] });
    }
  }
  const concrete = (p) => p.replace(/\/:[a-zA-Z]+\?/g, '').replace(/:[a-zA-Z]+/g, 'x').replace(/\/$/, '');
  // guardFor('/path') or guardFor('POST /path') where GET and POST differ.
  const guardFor = (spec) => {
    const [method, p] = spec.includes(' ') ? spec.split(' ') : [null, spec];
    const found = routes.filter((x) => x.path === p && (!method || x.method === method.toLowerCase()));
    assert.ok(found.length, `no ensureGroup guard on ${spec}`);
    return authService.ensureGroup(...found[0].args);
  };
  const pathOf = (spec) => (spec.includes(' ') ? spec.split(' ')[1] : spec);

  it('finds the Site Ops, Payroll and CIS guards', () => {
    for (const p of [
      '/attendance/:uuid/approve', '/attendance/bulk-approve', '/weekly-flow/:year?/:week?',
      '/weekly-management/:year?/:week?', '/payroll/run/:uuid/lock', '/payroll/run/:uuid/fps/submit',
      '/CIS/Dashboard/:year/:month', '/CIS/returns/all/:year', '/subcontractor/assign',
    ]) {
      assert.ok(routes.some((r) => r.path === p), `missing ${p}`);
    }
  });

  it('every job role a guard lets in also passes ensureRouteAccess (no dead links)', async () => {
    for (const r of routes) {
      const mw = authService.ensureGroup(...r.args);
      for (const slug of rbac.JOB_ROLES) {
        const user = { role: 'employee', roles: [slug] };
        if (await run(mw, user, concrete(r.path))) continue; // guard refused
        const globalErr = await run(authService.ensureRouteAccess, user, concrete(r.path));
        assert.equal(globalErr, undefined, `${slug} passes the guard on ${r.path} but ensureRouteAccess refuses it`);
      }
    }
  });

  it('a Contracts Manager can approve attendance; an Office Manager cannot', async () => {
    const mw = guardFor('/attendance/:uuid/approve');
    assert.equal(await run(mw, { role: 'employee', roles: ['contractsManager'] }), undefined);
    assert.equal((await run(mw, { role: 'employee', roles: ['officeManager'] }))?.statusCode, 403);
    assert.equal((await run(mw, { role: 'employee' }))?.statusCode, 403);
  });

  const asJob = (slug) => ({ role: 'employee', roles: [slug] });
  const allowed = async (spec, user) => {
    const p = concrete(pathOf(spec));
    if (await run(guardFor(spec), user, p)) return false;
    if (await run(authService.ensureRouteAccess, user, p)) return false;
    // paperlessRoutes also asks for the documents department.
    if (p.startsWith('/paperless') && await run(authService.ensureDepartment('documents'), user, p)) return false;
    return true;
  };

  it('Documents: the Office Manager enters data; sending to KashFlow and repairs stay admin', async () => {
    const office = asJob('officeManager');
    for (const p of [
      '/paperless/queues', '/paperless/queues/:queue', 'GET /paperless/ocr/:paperlessId',
      'GET /paperless/ocr/:paperlessId/entry', 'POST /paperless/ocr/:paperlessId/entry',
      '/paperless/ocr/:paperlessId/type', '/paperless/ocr/:paperlessId/supplier',
      '/overview/documents', '/company-docs/policies', 'POST /company-docs/policies',
    ]) assert.equal(await allowed(p, office), true, `office manager can't reach ${p}`);
    for (const p of [
      '/paperless/ocr/:paperlessId/reopen', 'POST /paperless/ocr/:paperlessId/match',
      '/company-docs/policies/:uuid/delete',
    ]) assert.equal(await allowed(p, office), false, `office manager reaches ${p}`);
    // Director holds approve.
    assert.equal(await allowed('/paperless/ocr/:paperlessId/reopen', asJob('director')), true);
    assert.equal(await allowed('POST /paperless/ocr/:paperlessId/match', asJob('director')), true);
  });

  it('Documents: nothing that writes to KashFlow, sends email, deletes or repairs is open to a job role', async () => {
    const manage = routes.filter((r) => r.args[0] === 'documents' && r.args[1] === 'manage');
    assert.ok(manage.length >= 15, `only ${manage.length} manage routes`);
    for (const p of ['/paperless/ocr/:paperlessId/send', 'POST /paperless/suppliers', 'DELETE /paperless/ocr/:paperlessId', '/paperless/repair-drift']) {
      assert.ok(manage.some((r) => r.path === pathOf(p)), `${p} is not at manage`);
    }
    for (const r of manage) {
      const spec = `${r.method.toUpperCase()} ${r.path}`;
      for (const slug of rbac.JOB_ROLES) assert.equal(await allowed(spec, asJob(slug)), false, `${slug} reaches ${spec}`);
      assert.equal(await allowed(spec, { role: 'admin' }), true, `admin loses ${spec}`);
    }
  });

  it('Website: a Director edits and publishes; settings stay admin', async () => {
    assert.equal(await allowed('POST /website/:type', asJob('director')), true);
    assert.equal(await allowed('/website/:type/:uuid/publish', asJob('director')), true);
    assert.equal(await allowed('GET /website/settings', asJob('director')), false);
    assert.equal(await allowed('POST /website/:type', asJob('officeManager')), false);
    assert.equal(await allowed('GET /website/settings', { role: 'admin' }), true);
  });

  it('Payroll: view reads runs, edit calculates, approve locks; the accountant keeps its reads', async () => {
    assert.equal(await allowed('/payroll/runs', asJob('payrollHr')), true);
    assert.equal(await allowed('/payroll/run/:uuid', asJob('payrollHr')), true);
    assert.equal(await allowed('/payroll/run/:uuid/calculate', asJob('payrollHr')), true);
    assert.equal(await allowed('/payroll/run/:uuid/lock', asJob('payrollHr')), true);
    assert.equal(await allowed('/payroll/employee/:uuid', asJob('payrollHr')), true);
    assert.equal(await allowed('/payroll/runs', { role: 'accountant' }), true);
    assert.equal(await allowed('/payroll/run/:uuid/lock', { role: 'accountant' }), false);
    // HR alone and Contracts Manager hold no Payroll grant.
    assert.equal(await allowed('/payroll/runs', asJob('officeManager')), false);
    assert.equal(await allowed('/payroll/runs', asJob('contractsManager')), false);
  });

  it('Payroll: nothing that leaves the app or undoes a lock is open to a job role', async () => {
    for (const p of [
      '/payroll/run/:uuid/unlock', '/payroll/run/:uuid/post-journal', '/payroll/run/:uuid/fps/submit',
      '/payroll/hmrc/eps/:year/:month/submit', '/payroll/run/:uuid/pension/submit',
    ]) {
      for (const slug of rbac.JOB_ROLES) assert.equal(await allowed(p, asJob(slug)), false, `${slug} reaches ${p}`);
      assert.equal(await allowed(p, { role: 'admin' }), true, `admin loses ${p}`);
    }
  });

  it('CIS: returns and the dashboard need approve; assign and supplier change stay admin', async () => {
    assert.equal(await allowed('/CIS/returns/all/:year', asJob('director')), true);
    assert.equal(await allowed('/CIS/Dashboard/:year/:month', asJob('director')), true);
    assert.equal(await allowed('/CIS/returns/all/:year', asJob('contractsManager')), false, 'CIS view must not see returns');
    assert.equal(await allowed('/CIS/returns/all/:year', { role: 'hmrc' }), true);
    for (const p of ['/subcontractor/assign', '/supplier/change/:uuid']) {
      for (const slug of rbac.JOB_ROLES) assert.equal(await allowed(p, asJob(slug)), false, `${slug} reaches ${p}`);
    }
  });
});
