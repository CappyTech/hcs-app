import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import modules from '../services/moduleService.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import departments from '../mongoose/config/departmentsConfig.js';
import { GROUPS } from '../services/configRegistry.js';
import { canUserOpenPath } from '../mongoose/services/overviewAccess.js';
import navigation from '../services/navigationService.js';
import scheduler from '../mongoose/services/jobSchedulerService.js';

const KEYS = modules.MODULES.map((m) => modules.configKey(m.id));
const admin = { role: 'admin', customPermissions: {} };
const accountant = { role: 'accountant', customPermissions: {} };

describe('moduleService', () => {
  const saved = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const off = (id) => { process.env[modules.configKey(id)] = 'false'; };

  describe('configuration', () => {
    it('has every module on until it is switched off', () => {
      for (const m of modules.MODULES) assert.equal(modules.isEnabled(m.id), true, m.id);
      assert.deepEqual(modules.disabledModules(), []);
    });

    it('reads common spellings of off, and anything else as on', () => {
      for (const v of ['false', 'FALSE', '0', 'off', 'no', ' false ']) {
        process.env.MODULE_FLEET = v;
        assert.equal(modules.isEnabled('fleet'), false, v);
      }
      for (const v of ['true', '1', 'yes', '']) {
        process.env.MODULE_FLEET = v;
        assert.equal(modules.isEnabled('fleet'), true, v);
      }
    });

    it('turns a module off with anything it requires', () => {
      off('finance');
      for (const id of ['cis', 'bank', 'job-register']) {
        assert.equal(modules.isEnabled(id), false, id);
        assert.equal(modules.offReason(id), 'finance');
      }
      assert.equal(modules.isEnabled('fleet'), true);
    });

    it('treats unknown ids as core', () => {
      assert.equal(modules.isEnabled('human-resources'), true);
    });

    it('offers one boolean setting per module on Configuration → Modules', () => {
      const group = GROUPS.find((g) => g.id === 'modules');
      assert.ok(group, 'modules group');
      assert.deepEqual(group.keys.map((k) => k.key), KEYS);
      for (const k of group.keys) assert.equal(k.type, 'boolean');
    });

    it('names only real departments, and no core one', () => {
      for (const m of modules.MODULES) {
        for (const d of m.departments || []) assert.ok(departments[d], `${m.id}: unknown department ${d}`);
      }
      const owned = new Set(modules.MODULES.flatMap((m) => m.departments || []));
      for (const core of ['admin', 'human-resources', 'attendance', 'user', 'management']) {
        assert.ok(!owned.has(core), `${core} must stay on`);
      }
    });

    it('names only real jobs', async () => {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync('mongoose/services/jobRegistry.js', 'utf8');
      for (const m of modules.MODULES) {
        for (const j of m.jobs || []) assert.ok(src.includes(`'${j}'`), `${m.id}: unknown job ${j}`);
      }
    });
  });

  describe('paths', () => {
    it('owns its paths and everything below them, ignoring case', () => {
      off('cis');
      for (const p of ['/CIS', '/CIS/Dashboard/2026/1', '/cis/returns/form', '/subcontractor/assign', '/overview/subcontractors', '/CIS/?x=1']) {
        assert.equal(modules.isPathEnabled(p), false, p);
      }
    });

    it('does not match a longer word that only starts the same', () => {
      off('fleet');
      assert.equal(modules.isPathEnabled('/vehicles'), false);
      assert.equal(modules.isPathEnabled('/vehicle/read/abc'), false);
      assert.equal(modules.isPathEnabled('/vehicle-deployment'), false);
      process.env.MODULE_FLEET = 'true';
      off('cis');
      assert.equal(modules.isPathEnabled('/subcontractors-not-a-thing'), true);
      assert.equal(modules.isPathEnabled('/supplier/read/abc'), true, 'suppliers stay: attendance uses them');
    });

    it('covers a model\'s generic pages', () => {
      off('health-safety');
      for (const p of ['/trainingrecord/create', '/trainingrecords', '/overview/trainingRecord']) {
        assert.equal(modules.isPathEnabled(p), false, p);
      }
    });

    it('leaves core pages alone', () => {
      for (const m of modules.MODULES) off(m.id);
      for (const p of ['/', '/employees', '/daily', '/weekly-flow', '/holidayRequests', '/admin/config', '/admin/config/modules', '/help', '/search', '/overview/human', '/contracts', '/projects', '/suppliers', '/user/account']) {
        assert.equal(modules.isPathEnabled(p), true, p);
      }
    });
  });

  describe('everything that asks for access', () => {
    it('refuses routes, departments and models of a module that is off, even to admins', () => {
      off('payroll');
      assert.equal(rbac.canAccessRoute(['admin'], '/overview/payroll'), false);
      assert.equal(rbac.canAccessDepartment(['admin'], 'payroll'), false);
      assert.equal(rbac.canAccess(['admin'], 'payrollRun', 'l').allowed, false);
      assert.ok(!rbac.getDepartmentsForRole('accountant').includes('payroll'));
      assert.equal(canUserOpenPath(admin, '/overview/payroll'), false);
      // Untouched modules and core are unaffected.
      assert.equal(rbac.canAccessDepartment(['admin'], 'finance'), true);
      assert.equal(rbac.canAccess(['admin'], 'employee', 'l').allowed, true);
    });

    it('drops it from the navigation', () => {
      const slugs = () => navigation.build({ path: '/', user: accountant }).items.map((i) => i.slug);
      assert.ok(slugs().some((s) => /payroll/.test(s)));
      off('payroll');
      assert.ok(!slugs().some((s) => /payroll/.test(s)));
    });

    it('answers 404 at the gate, and lets everything else through', () => {
      off('website');
      let err = null;
      modules.gate({ path: '/website/pages' }, {}, (e) => { err = e; });
      assert.equal(err?.statusCode, 404);
      assert.match(err.message, /Website is switched off/);
      assert.equal(err.name, 'ModuleOffError');
      let passed = false;
      modules.gate({ path: '/employees' }, {}, (e) => { passed = e === undefined; });
      assert.equal(passed, true);
    });

    it('stops its APIs with a JSON 404, ahead of sign-in', () => {
      off('website');
      const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      let nexted = false;
      modules.apiGate({ path: '/api/web/content' }, res, () => { nexted = true; });
      assert.equal(nexted, false);
      assert.equal(res.code, 404);
      assert.equal(res.body.error, 'not_found');
      // Other APIs, and pages (left to the page gate), pass straight through.
      for (const path of ['/api/sso/token', '/website/pages']) {
        nexted = false;
        modules.apiGate({ path }, res, () => { nexted = true; });
        assert.equal(nexted, true, path);
      }
    });

    it('skips its background jobs', async () => {
      scheduler._reset();
      let ran = 0;
      scheduler.register('vehicle-compliance', { description: 't', run: async () => { ran++; } });
      off('fleet');
      const out = await scheduler.runNow('vehicle-compliance');
      assert.equal(ran, 0);
      assert.equal(out.skipped, true);
      process.env.MODULE_FLEET = 'true';
      await scheduler.runNow('vehicle-compliance');
      assert.equal(ran, 1);
      scheduler._reset();
    });

    it('hides its help', () => {
      off('bank');
      assert.equal(modules.isHelpEnabled('bank-reconciliation'), false);
      assert.equal(modules.isHelpEnabled('finance'), true, 'the rest of Finance help stays');
    });
  });
});
