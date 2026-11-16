import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ejs from 'ejs';
import { memoryModel } from './helpers/memoryModel.js';

/**
 * The employee page shows a Policies card: documents assigned to that
 * employee in Company Docs. Documents viewers see drafts too; the employee
 * themself sees only published ones and may print them.
 */

process.env.ENCRYPTION_KEY ||= 'test-key';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);

let mdb, ctrl, crudConfig;
const EMP = 'e1';
const OTHER = 'e2';
const rows = [
  { uuid: 'p1', title: 'Contract', category: 'Employee Contract', version: '1.0', isPublished: true, employee: EMP, reviewIntervalMonths: 0 },
  { uuid: 'p2', title: 'Onboarding', category: 'Onboarding', version: '1.0', isPublished: false, employee: EMP, reviewIntervalMonths: 0 },
  { uuid: 'p3', title: 'Someone else', category: 'HR', version: '1.0', isPublished: true, employee: OTHER, reviewIntervalMonths: 0 },
  { uuid: 'p4', title: 'Company-wide', category: 'HR', version: '1.0', isPublished: true, employee: null, reviewIntervalMonths: 0 },
];

before(async () => {
  mdb = (await imp('mongoose/services/mongooseDatabaseService.js')).default;
  mdb.INTERNAL ||= {};
  ctrl = await imp('mongoose/controllers/companyDocsController.js');
  crudConfig = (await imp('mongoose/config/CRUDControllerConfig.js')).default;
});

beforeEach(() => {
  const m = memoryModel(rows);
  m.exists = async (f) => (m.docs.some((d) => Object.entries(f).every(([k, v]) => d[k] === v)) ? { _id: 1 } : null);
  mdb.INTERNAL.policyDocument = m;
});

const titles = (r) => r.policies.map((p) => p.title).sort();

describe('loadEmployeePolicies', () => {
  it('shows an admin every document assigned to the employee, drafts included', async () => {
    const r = await ctrl.loadEmployeePolicies({ _id: EMP }, { role: 'admin' });
    assert.deepEqual(titles(r), ['Contract', 'Onboarding']);
    assert.equal(r.canEdit, true);
    assert.equal(r.showStatus, true);
  });

  it('shows the employee only their own published documents', async () => {
    const r = await ctrl.loadEmployeePolicies({ _id: EMP }, { role: 'employee', employeeId: EMP });
    assert.deepEqual(titles(r), ['Contract']);
    assert.equal(r.canEdit, false);
    assert.equal(r.showStatus, false);
  });

  it('shows nothing to someone without Documents access viewing another employee', async () => {
    assert.equal(await ctrl.loadEmployeePolicies({ _id: EMP }, { role: 'employee', employeeId: OTHER }), null);
  });

  it('is wired into the employee read view', async () => {
    const locals = await crudConfig.employee.readLocals({ _id: EMP }, { user: { role: 'admin' } });
    assert.deepEqual(titles(locals.employeePolicies), ['Contract', 'Onboarding']);
  });
});

describe('ensureCanPrintPolicy', () => {
  const deny = (_req, _res, next) => next({ statusCode: 403 });
  const run = (user, uuid) => new Promise((resolve) => {
    ctrl.ensureCanPrintPolicy(deny)({ user, params: { uuid } }, {}, (err) => resolve(err || 'ok'));
  });

  it('lets through anyone the Documents view guard allows', async () => {
    const r = await new Promise((resolve) => ctrl.ensureCanPrintPolicy((_q, _s, n) => n())({ params: {} }, {}, (e) => resolve(e || 'ok')));
    assert.equal(r, 'ok');
  });

  it('lets the assigned employee print their published document', async () => {
    assert.equal(await run({ role: 'employee', employeeId: EMP }, 'p1'), 'ok');
  });

  it("refuses drafts, other people's documents and company-wide policies", async () => {
    for (const uuid of ['p2', 'p3', 'p4']) {
      assert.equal((await run({ role: 'employee', employeeId: EMP }, uuid)).statusCode, 403, uuid);
    }
  });
});

describe('employee policies card', () => {
  const file = path.join(root, 'mongoose/views/tailwindcss/partials/_employee-policies-card.ejs');
  const render = (employeePolicies) => ejs.renderFile(file, { item: { uuid: 'u-1' }, employeePolicies });

  it('lists documents with view links, and edit links for editors', async () => {
    const html = await render({ canEdit: true, showStatus: true, policies: [{ uuid: 'p2', title: 'Onboarding', category: 'Onboarding', version: '1.0', isPublished: false }] });
    assert.match(html, /Onboarding/);
    assert.match(html, /\/company-docs\/policies\/p2\/print/);
    assert.match(html, /\/company-docs\/policies\/p2\/edit/);
    assert.match(html, /Draft/);
    assert.match(html, /policies\/create\?employee=u-1/);
  });

  it('hides edit controls and status from the employee', async () => {
    const html = await render({ canEdit: false, showStatus: false, policies: [{ uuid: 'p1', title: 'Contract', category: 'Employee Contract', version: '1.0', isPublished: true }] });
    assert.doesNotMatch(html, /\/edit"/);
    assert.doesNotMatch(html, /New document/);
    assert.doesNotMatch(html, /Published/);
  });

  it('says so when nothing is assigned', async () => {
    assert.match(await render({ canEdit: false, showStatus: true, policies: [] }), /No documents assigned/);
  });
});
