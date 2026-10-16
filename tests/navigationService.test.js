import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import nav from '../services/navigationService.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';

/**
 * navigationService builds the one list every header style draws from:
 * which departments this person may open, in config order, grouped, with
 * the active one marked and the command rail's pinned set resolved.
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
  it('lists, in config order, exactly the departments the role may open and that show in nav', () => {
    const built = nav.build({ path: '/', user: as('admin') });
    const expected = Object.entries(departmentsConfig)
      .filter(([slug, d]) => d.showInNav !== false && rbac.canAccessDepartment('admin', slug, {}))
      .map(([slug]) => slug);
    assert.deepEqual(built.items.map((i) => i.slug), expected);
    assert.ok(built.items.length > 5);
    for (const item of built.items) {
      assert.equal(item.href, departmentsConfig[item.slug].path || `/${item.slug}`);
      assert.equal(item.label, departmentsConfig[item.slug].navLabel);
    }
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

describe('grouping', () => {
  it('orders groups People, Money, Work, System and drops empty ones', () => {
    const admin = nav.build({ path: '/', user: as('admin') });
    assert.deepEqual(admin.groups.map((g) => g.key), ['people', 'money', 'work', 'system']);
    assert.ok(admin.groups.find((g) => g.key === 'money').items.some((i) => i.slug === 'finance'));
    assert.ok(admin.groups.find((g) => g.key === 'people').items.some((i) => i.slug === 'human-resources'));

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
    const built = nav.build({ path: '/finance/invoices', user: as('admin') });
    assert.deepEqual(built.items.filter((i) => i.active).map((i) => i.slug), ['finance']);
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
    assert.deepEqual(built.pinned.map((i) => i.slug), ['human-resources', 'attendance', 'documents', 'finance', 'construction-industry-scheme']);
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
    assert.ok(moreSlugs.includes('human-resources'));
    assert.ok(!moreSlugs.includes('finance'));
  });

  it('an empty chosen list pins nothing and puts everything under More', () => {
    const built = nav.build({ path: '/', user: as('admin'), pinned: [] });
    assert.deepEqual(built.pinned, []);
    assert.ok(built.more.flatMap((g) => g.items).length > 5);
  });
});
