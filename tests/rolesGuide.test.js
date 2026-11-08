import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ejs from 'ejs';

import guide from '../mongoose/config/rolesGuideConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import rolesGuideController, { jobRoleEntries } from '../mongoose/controllers/rolesGuideController.js';
import { PUBLIC_PATHS_FOR_TEST } from '../services/authService.js';

describe('roles guide', () => {
  it('covers every account role', () => {
    const ids = guide.roles.map((r) => r.id);
    for (const role of ['admin', 'accountant', 'employee', 'subcontractor', 'client', 'hmrc', 'auditor', 'none']) {
      assert.ok(ids.includes(role), `missing ${role}`);
    }
    assert.equal(new Set(ids).size, ids.length);
  });

  it('prose only for job roles that exist', () => {
    for (const slug of Object.keys(guide.jobRoles)) {
      assert.ok(accessGroups.jobRoles[slug], `unknown job role ${slug}`);
    }
  });

  it('derives job-role areas from the grants', () => {
    const entries = jobRoleEntries();
    const site = entries.find((e) => e.id === 'siteManager');
    assert.ok(site);
    assert.ok(site.areas.some((a) => a.label === 'Site Ops' && a.level === 'approve' && a.ownSites));
    const director = entries.find((e) => e.id === 'director');
    assert.ok(director.areas.every((a) => !a.ownSites));
  });

  it('anchors never collide', () => {
    const ids = [...guide.roles.map((r) => r.id), ...jobRoleEntries().map((r) => r.id), 'job-roles', 'account-roles'];
    assert.equal(new Set(ids).size, ids.length);
  });

  it('is public', () => {
    assert.ok(PUBLIC_PATHS_FOR_TEST.has('/roles'));
  });

  it('renders signed out', async () => {
    let view; let locals;
    rolesGuideController.getRolesGuide({}, { render: (v, l) => { view = v; locals = l; } });
    const file = path.join('mongoose', 'views', view + '.ejs');
    const html = await ejs.renderFile(file, locals);
    assert.match(html, /id="employee"/);
    assert.match(html, /What's in it for you/);
    assert.match(html, /Log in/);
  });
});
