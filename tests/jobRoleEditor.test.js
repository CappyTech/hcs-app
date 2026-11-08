import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import svc from '../mongoose/services/jobRoleConfigService.js';
import { parseForm } from '../mongoose/controllers/jobRoleEditorController.js';
import { jobRoleEntries } from '../mongoose/controllers/rolesGuideController.js';

const view = (p) => fileURLToPath(new URL(`../mongoose/views/tailwindcss/admin/jobRoles/${p}.ejs`, import.meta.url));
const clone = (v) => JSON.parse(JSON.stringify(v));
const director = () => ({ slug: 'director', custom: false, ...clone(accessGroups.defaultJobRoles.director) });

// In-memory jobRoleConfig and user collections for the store.
function stubDb({ users = [], failSave = false } = {}) {
  const rows = new Map();
  class Doc {
    constructor(init) { Object.assign(this, init); }
    async save() { if (failSave) throw new Error('disk full'); rows.set(this.slug, { ...this }); }
    async deleteOne() { rows.delete(this.slug); }
  }
  mdb.INTERNAL = {
    jobRoleConfig: Object.assign(Doc, {
      findOne: async ({ slug }) => (rows.has(slug) ? new Doc(rows.get(slug)) : null),
      find: () => ({ lean: async () => [...rows.values()] }),
    }),
    user: {
      aggregate: async () => {
        const n = {};
        for (const u of users) for (const r of u.roles) n[r] = (n[r] || 0) + 1;
        return Object.entries(n).map(([_id, c]) => ({ _id, n: c }));
      },
    },
  };
  return rows;
}

const savedInternal = mdb.INTERNAL;
async function restore() {
  stubDb();
  await svc.load(); // empty store: defaults back, cache cleared
  mdb.INTERNAL = savedInternal;
}

describe('job roles recompile at runtime', () => {
  afterEach(() => { accessGroups.applyJobRoleOverrides([]); rbac.recompileJobRoles(); });

  it('a changed built-in role changes the tables, and the defaults come back', () => {
    assert.ok(rbac.routeAccess['/bank'].includes('director'));
    const d = director();
    d.grants = d.grants.filter((g) => g.group !== 'finance');
    accessGroups.applyJobRoleOverrides([d]);
    rbac.recompileJobRoles();
    assert.ok(!rbac.routeAccess['/bank'].includes('director'));
    assert.ok(!rbac.hasGroup({ role: 'employee', roles: ['director'] }, 'finance', 'view'));

    accessGroups.applyJobRoleOverrides([]);
    rbac.recompileJobRoles();
    assert.ok(rbac.routeAccess['/bank'].includes('director'));
    assert.deepEqual(accessGroups.jobRoles.director, clone(accessGroups.defaultJobRoles.director));
  });

  it('an added role compiles like a built-in one; turned off, it grants nothing', () => {
    const custom = { slug: 'plantHire', custom: true, label: 'Plant Hire', description: '', values: 'never', grants: [{ group: 'fleet', level: 'manage' }] };
    accessGroups.applyJobRoleOverrides([custom]);
    rbac.recompileJobRoles();
    const user = { role: 'employee', roles: ['plantHire'] };
    assert.ok(rbac.JOB_ROLES.has('plantHire'));
    assert.ok(accessGroups.JOB_ROLE_SLUGS.includes('plantHire'));
    assert.ok(rbac.hasGroup(user, 'fleet', 'manage'));
    assert.ok(rbac.roleModelAccess.plantHire);

    accessGroups.applyJobRoleOverrides([{ ...custom, disabled: true }]);
    rbac.recompileJobRoles();
    assert.ok(!rbac.JOB_ROLES.has('plantHire'));
    assert.deepEqual(rbac.jobRolesOf(user), []);
    assert.equal(rbac.roleModelAccess.plantHire, undefined);
  });

  it('defaults are read-only', () => {
    assert.throws(() => { accessGroups.defaultJobRoles.director.grants.push({}); });
  });
});

describe('validation', () => {
  const base = { label: 'X', description: '', values: 'never', grants: [{ group: 'fleet', level: 'view' }] };
  const bad = (input, opts, re) => assert.throws(() => svc.validate(input, opts), (e) => e instanceof svc.JobRoleError && re.test(e.message));

  it('refuses reserved, clashing and malformed names', () => {
    bad(base, { slug: 'admin', custom: true }, /built-in account role/);
    bad(base, { slug: 'director', custom: true }, /built-in job role/);
    bad(base, { slug: 'Bad-Slug', custom: true }, /identifier/);
    bad(base, { slug: 'notThere', custom: false }, /no built-in/);
  });

  it('refuses System above view, a group twice, unknown groups, and an empty role that is on', () => {
    bad({ ...base, grants: [{ group: 'system', level: 'edit' }] }, { slug: 'xx', custom: true }, /at view at most/);
    bad({ ...base, grants: [{ group: 'fleet', level: 'view' }, { group: 'fleet', level: 'edit' }] }, { slug: 'xx', custom: true }, /twice/);
    bad({ ...base, grants: [{ group: 'nope', level: 'view' }] }, { slug: 'xx', custom: true }, /Unknown area/);
    bad({ ...base, grants: [] }, { slug: 'xx', custom: true }, /at least one area/);
    bad({ ...base, values: 'sometimes' }, { slug: 'xx', custom: true }, /sees money/);
  });

  it('allows own-sites scope only where it limits something', () => {
    const unscopable = Object.keys(accessGroups.groups).find((k) => !svc.groupScopable(k));
    assert.ok(svc.groupScopable('siteOps'));
    bad({ ...base, grants: [{ group: unscopable, level: 'view', scope: 'project' }] }, { slug: 'xx', custom: true }, /own sites/);
    const ok = svc.validate({ ...base, grants: [{ group: 'siteOps', level: 'view', scope: 'project' }] }, { slug: 'xx', custom: true });
    assert.deepEqual(ok.grants, [{ group: 'siteOps', level: 'view', scope: 'project' }]);
  });

  it('allows manage on the money groups (the two-person rule covers it)', () => {
    const ok = svc.validate({ ...base, grants: [{ group: 'finance', level: 'manage' }] }, { slug: 'xx', custom: true });
    assert.equal(ok.grants[0].level, 'manage');
  });

  it('makes a unique camelCase identifier from a name', () => {
    assert.equal(svc.slugFor('Site Engineer'), 'siteEngineer');
    assert.equal(svc.slugFor('Director'), 'director2');
    assert.equal(svc.slugFor('  3D  modeller! '), 'role3dModeller');
    assert.equal(svc.slugFor('Admin'), 'admin2');
  });
});

describe('store', () => {
  afterEach(restore);

  it('save applies and stores a built-in change; reset puts the default back', async () => {
    const rows = stubDb();
    await svc.load();
    const d = director();
    d.label = 'Managing Director';
    await svc.save('director', d, { _id: 'u1' });
    assert.equal(accessGroups.jobRoles.director.label, 'Managing Director');
    assert.equal(rows.get('director').label, 'Managing Director');
    assert.ok(svc.isChanged('director'));

    await svc.reset('director');
    assert.equal(accessGroups.jobRoles.director.label, 'Director');
    assert.ok(!rows.has('director'));
  });

  it('a failed write leaves the live roles as they were', async () => {
    stubDb({ failSave: true });
    await svc.load();
    const d = director();
    d.grants = [{ group: 'fleet', level: 'view' }];
    await assert.rejects(() => svc.save('director', d, null), /disk full/);
    assert.ok(rbac.routeAccess['/bank'].includes('director'));
  });

  it('create adds a role turned off; it can only be deleted once nobody holds it', async () => {
    stubDb({ users: [{ roles: ['estimator'] }] });
    await svc.load();
    const def = await svc.create('Estimator', null);
    assert.equal(def.slug, 'estimator');
    assert.equal(accessGroups.jobRoles.estimator.disabled, true);
    assert.ok(!rbac.JOB_ROLES.has('estimator'));
    await assert.rejects(() => svc.reset('estimator'), /1 person holds this job role/);

    stubDb();
    await svc.load(); // nothing stored in the new stub
    assert.equal(accessGroups.jobRoles.estimator, undefined);
  });

  it('load skips a stored role that no longer validates', async () => {
    const rows = stubDb();
    rows.set('director', { ...director(), grants: [{ group: 'gone', level: 'view' }] });
    await svc.load();
    assert.deepEqual(accessGroups.jobRoles.director, clone(accessGroups.defaultJobRoles.director));
  });
});

describe('editor form and pages', () => {
  beforeEach(() => stubDb());
  afterEach(restore);

  it('parseForm reads levels, own-sites and money ticks, and the on switch', () => {
    const def = parseForm({
      label: ' Gang Lead ', description: '', values: 'flag', enabled: 'on',
      level: { siteOps: 'edit', fleet: '', commercial: 'view' }, scope: { siteOps: 'on' }, money: { commercial: 'on' },
    });
    assert.equal(def.label, 'Gang Lead');
    assert.equal(def.disabled, false);
    assert.deepEqual(def.grants, [
      { group: 'siteOps', level: 'edit', scope: 'project', values: false },
      { group: 'commercial', level: 'view', scope: 'all', values: true },
    ]);
    assert.equal(parseForm({ label: 'x', values: 'never' }).disabled, true);
  });

  it('index and edit pages render', async () => {
    const roles = [{ slug: 'director', label: 'Director', description: 'd', custom: false, changed: true, disabled: false, holders: 2, areas: ['Finance (manage)'] }];
    const index = await ejs.renderFile(view('index'), { title: 't', csrfToken: 'c', roles }, { async: true });
    assert.match(index, /href="\/admin\/job-roles\/director"/);
    assert.match(index, /Changed/);
    assert.match(index, /action="\/admin\/job-roles"/);

    const def = accessGroups.jobRoles.director;
    const areas = Object.entries(accessGroups.groups).map(([key, g]) => ({
      key, label: g.label, description: g.description,
      levels: accessGroups.LEVELS.slice(0, accessGroups.LEVELS.indexOf(svc.maxLevel(key)) + 1),
      scopable: svc.groupScopable(key),
    }));
    const edit = await ejs.renderFile(view('edit'), {
      title: 't', csrfToken: 'c', slug: 'director', def, areas, custom: false, changed: false, holders: 1,
      grants: Object.fromEntries(def.grants.map((g) => [g.group, g])),
    }, { async: true });
    assert.match(edit, /name="level\[finance\]"[\s\S]*?<option value="manage" selected/);
    assert.doesNotMatch(edit, /name="level\[system\]"[\s\S]*?<option value="edit"/);
    assert.doesNotMatch(edit, /Reset to default/);
  });

  it('the Roles page drops the written notes once a role is changed', async () => {
    assert.ok(jobRoleEntries().find((r) => r.id === 'director').uses.length);
    const d = director();
    d.grants = d.grants.filter((g) => g.group !== 'website');
    await svc.save('director', d, null);
    assert.deepEqual(jobRoleEntries().find((r) => r.id === 'director').uses, []);
  });
});
