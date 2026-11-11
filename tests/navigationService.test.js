import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import nav from '../services/navigationService.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import registry from '../mongoose/config/overviews/index.js';

/**
 * navigationService builds the one list every header style draws from: the
 * overview areas this person may open, in hierarchy order, then the
 * departments no area stands in for, grouped, with the active one marked and
 * the command rail's pinned set resolved.
 */

const as = (role, extra = {}) => ({ role, customPermissions: {}, ...extra });

describe('departmentsConfig groups', () => {
  it('gives every department one of the four groups', () => {
    const keys = nav.GROUPS.map((g) => g.key);
    for (const [slug, dept] of Object.entries(departmentsConfig)) {
      assert.ok(keys.includes(dept.group), `${slug} has group ${dept.group}`);
    }
  });
});

describe('navigation items', () => {
  it('lists the areas the role may open in hierarchy order, then the departments no shown area replaces', () => {
    const built = nav.build({ path: '/', user: as('admin') });
    const areas = registry.listAreas();
    const areaIds = new Set(areas.map((a) => a.id));
    const expected = [
      ...areas.map((a) => a.id),
      ...Object.entries(departmentsConfig)
        .filter(([slug, d]) => d.showInNav !== false && rbac.canAccessDepartment('admin', slug, {}) && !(d.navArea && areaIds.has(d.navArea)))
        .map(([slug]) => slug),
    ];
    assert.deepEqual(built.items.map((i) => i.slug), expected);
    for (const item of built.items) {
      if (item.area) {
        const area = registry.getArea(item.area);
        assert.equal(item.href, area.path);
        assert.equal(item.label, area.navLabel || area.label);
      } else {
        assert.equal(item.href, departmentsConfig[item.slug].path || `/${item.slug}`);
        assert.equal(item.label, departmentsConfig[item.slug].navLabel);
      }
    }
  });

  it('every navArea names a real area', () => {
    for (const [slug, d] of Object.entries(departmentsConfig)) {
      if (d.navArea) assert.ok(registry.getArea(d.navArea), `${slug}.navArea '${d.navArea}'`);
    }
  });

  it('keeps a department when the person can open it but not the area that would replace it', () => {
    const widened = nav.build({ path: '/', user: as('employee', { customPermissions: { departments: ['payroll'] } }) });
    const item = widened.items.find((i) => i.slug === 'payroll');
    assert.ok(item);
    assert.equal(item.href, '/payroll');
  });

  it('filters by canDept for a narrower role, and custom permissions widen it', () => {
    const employee = nav.build({ path: '/', user: as('employee') });
    const slugs = employee.items.map((i) => i.slug);
    assert.ok(slugs.includes('attendance'));
    assert.ok(slugs.includes('user'));
    assert.ok(!slugs.includes('admin'));
    assert.ok(!slugs.includes('finance'));
    assert.equal(employee.create, null, 'employees have no Create');

    const widened = nav.build({ path: '/', user: as('employee', { customPermissions: { departments: ['finance'] } }) });
    assert.ok(widened.items.map((i) => i.slug).includes('finance'), 'a custom department permission shows in the nav');
  });

  it('shows nothing to nobody', () => {
    const built = nav.build({ path: '/', user: null });
    assert.deepEqual(built.items, []);
    assert.deepEqual(built.groups, []);
    assert.deepEqual(built.pinned, []);
  });

  it('separates Create and the account link from the groups', () => {
    const built = nav.build({ path: '/', user: as('admin') });
    assert.equal(built.create?.slug, 'create');
    assert.equal(built.account?.slug, 'user');
    const inGroups = built.groups.flatMap((g) => g.items.map((i) => i.slug));
    assert.ok(!inGroups.includes('create'));
    assert.ok(!inGroups.includes('user'));
    // but every other visible department is in exactly one group
    const others = built.items.filter((i) => i.slug !== 'create' && i.slug !== 'user').map((i) => i.slug);
    assert.deepEqual([...inGroups].sort(), [...others].sort());
  });
});

describe('Fleet area', () => {
  it('stands in for Maintenance and sits in the Work group', () => {
    const built = nav.build({ user: as('admin') });
    const slugs = built.items.map((i) => i.slug);
    assert.ok(slugs.includes('fleet'));
    assert.ok(!slugs.includes('maintenance'));
    assert.equal(built.items.find((i) => i.slug === 'fleet').group, 'work');
    assert.equal(nav.build({ path: '/maintenance', user: as('admin') }).active.slug, 'fleet', 'the Maintenance dashboard lights up Fleet');
  });
});

describe('Health & Safety area', () => {
  const slugs = (user) => nav.build({ user }).items.map((i) => i.slug);
  const jobRole = (slug) => as('none', { roles: [slug] });
  const anyHealth = (list) => list.some((x) => /health/i.test(x));

  it('opens the overview and has no generated dashboard', () => {
    const item = nav.build({ user: as('admin') }).items.find((i) => i.slug === 'healthSafety');
    assert.equal(item.href, '/overview/healthSafety');
    assert.equal(item.group, 'work');
    assert.equal(departmentsConfig['health-safety'].hasDashboard, false);
    assert.ok(!slugs(as('admin')).includes('health-safety'), 'the department link gives way to the area');
  });

  it('shows to admins and job roles holding Health & Safety on every site', () => {
    assert.ok(slugs(as('admin')).includes('healthSafety'));
    for (const r of ['healthSafetyAdvisor', 'director', 'contractsManager']) {
      assert.ok(slugs(jobRole(r)).includes('healthSafety'), r);
      assert.ok(rbac.canAccessRoute(rbac.rolesOf(jobRole(r)), '/overview/healthSafety'), `${r} can open it`);
    }
  });

  it('is hidden from site-only job roles and plain accounts', () => {
    for (const r of ['siteManager', 'supervisor']) assert.ok(!anyHealth(slugs(jobRole(r))), r);
    for (const r of ['employee', 'subcontractor', 'accountant']) assert.ok(!anyHealth(slugs(as(r))), r);
  });
});

describe('overview pages light up their area', () => {
  it('marks the area for its own page and for a child overview', () => {
    assert.equal(nav.build({ path: '/overview/human', user: as('admin') }).active.slug, 'human');
    assert.equal(nav.build({ path: '/overview/employee', user: as('admin') }).active.slug, 'human');
    assert.equal(nav.build({ path: '/overview/invoice', user: as('admin') }).active.slug, 'finance');
  });

  it('shows an accountant the areas their routes open, not the admin-only ones', () => {
    const slugs = nav.build({ user: as('accountant') }).items.map((i) => i.slug);
    for (const x of ['finance', 'payroll', 'subcontractors', 'weeklyAttendance']) assert.ok(slugs.includes(x), x);
    for (const x of ['human', 'fleet', 'admin', 'policies']) assert.ok(!slugs.includes(x), x);
  });
});

describe('grouping', () => {
  it('orders groups People, Money, Work, System and drops empty ones', () => {
    const admin = nav.build({ path: '/', user: as('admin') });
    assert.deepEqual(admin.groups.map((g) => g.key), ['people', 'money', 'work', 'system']);
    assert.ok(admin.groups.find((g) => g.key === 'money').items.some((i) => i.slug === 'finance'));
    assert.ok(admin.groups.find((g) => g.key === 'people').items.some((i) => i.slug === 'human'));

    const employee = nav.build({ path: '/', user: as('employee') });
    assert.deepEqual(employee.groups.map((g) => g.key), ['people']);
  });
});

describe('active detection', () => {
  it('uses the same rule as navActive: exact path or a sub-path, Home only exactly', () => {
    assert.equal(nav.isActive('/', '/'), true);
    assert.equal(nav.isActive('/finance', '/'), false);
    assert.equal(nav.isActive('/finance', '/finance'), true);
    assert.equal(nav.isActive('/finance/invoices', '/finance'), true);
    assert.equal(nav.isActive('/finances', '/finance'), false);
  });

  it('marks exactly the active item, its group, and the breadcrumb target', () => {
    // The Finance area stands in for the Finance department, so /finance/... lights it up
    const built = nav.build({ path: '/finance/invoices', user: as('admin') });
    assert.deepEqual(built.items.filter((i) => i.active).map((i) => i.slug), ['finance']);
    assert.equal(built.active.href, '/overview/finance');
    assert.equal(built.active.slug, 'finance');
    assert.deepEqual(built.groups.filter((g) => g.active).map((g) => g.key), ['money']);
    assert.equal(built.home.active, false);

    const home = nav.build({ path: '/', user: as('admin') });
    assert.equal(home.home.active, true);
    assert.equal(home.active.slug, 'home');
    assert.ok(home.items.every((i) => !i.active));

    const help = nav.build({ path: '/help/api', user: as('admin') });
    assert.equal(help.help.active, true);
    assert.equal(help.active.slug, 'help');
  });

  it('honours a path override such as the accountant portal', () => {
    const built = nav.build({ path: '/accountant/ledger', user: as('admin') });
    assert.equal(built.active.slug, 'accountant-portal');
  });
});

describe('pinned items (command rail)', () => {
  it('defaults to HR, Attendance, Documents, Finance and CIS for an admin, with the rest under More', () => {
    const built = nav.build({ path: '/', user: as('admin') });
    // HR, Documents and Finance pin the areas that stand in for those departments
    assert.deepEqual(built.pinned.map((i) => i.slug), ['human', 'attendance', 'documents', 'finance', 'construction-industry-scheme']);
    const moreSlugs = built.more.flatMap((g) => g.items.map((i) => i.slug));
    for (const p of built.pinned) assert.ok(!moreSlugs.includes(p.slug), `${p.slug} is not also under More`);
    assert.ok(moreSlugs.includes('admin'));
    assert.ok(!moreSlugs.includes('create'));
    const all = [...built.pinned.map((i) => i.slug), ...moreSlugs].sort();
    assert.deepEqual(all, built.items.filter((i) => i.slug !== 'create' && i.slug !== 'user').map((i) => i.slug).sort());
  });

  it('only pins what the person may open, so the defaults shrink for an employee', () => {
    const built = nav.build({ path: '/', user: as('employee') });
    assert.deepEqual(built.pinned.map((i) => i.slug), ['attendance']);
    assert.deepEqual(built.more, []);
  });

  it('keeps a chosen list in order, dropping unknown, hidden and duplicate slugs', () => {
    const built = nav.build({ path: '/', user: as('admin'), pinned: ['admin', 'finance', 'nope', 'create', 'user', 'admin'] });
    assert.deepEqual(built.pinned.map((i) => i.slug), ['admin', 'finance']);
    const moreSlugs = built.more.flatMap((g) => g.items.map((i) => i.slug));
    assert.ok(moreSlugs.includes('human'));
    assert.ok(!moreSlugs.includes('finance'));
    const legacy = nav.build({ path: '/', user: as('admin'), pinned: ['human-resources', 'maintenance'] });
    assert.deepEqual(legacy.pinned.map((i) => i.slug), ['human', 'fleet'], 'a pinned department pins the area that replaced it');
  });

  it('an empty chosen list pins nothing and puts everything under More', () => {
    const built = nav.build({ path: '/', user: as('admin'), pinned: [] });
    assert.deepEqual(built.pinned, []);
    assert.ok(built.more.flatMap((g) => g.items).length > 5);
  });
});
