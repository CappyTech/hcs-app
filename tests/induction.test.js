import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';
import inductionModel, { INDUCTION_TOPICS } from '../mongoose/models/mongoose/INTERNAL/induction.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import overviews from '../mongoose/config/overviews/index.js';
import ctrl from '../mongoose/controllers/inductionController.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';
import notificationService from '../services/notificationService.js';
import svc from '../mongoose/services/healthSafetyComplianceService.js';

const Induction = mongoose.models.inductionTest || mongoose.model('inductionTest', inductionModel.schema.clone());
const oid = () => new mongoose.Types.ObjectId();
const days = (n) => new Date(Date.now() + n * 864e5);
const view = fileURLToPath(new URL('../mongoose/views/tailwindcss/healthSafety/recordInduction.ejs', import.meta.url));
const as = (jobRole) => ({ _id: oid(), role: 'employee', roles: [jobRole] });

describe('induction model', () => {
  it('needs a site, a date and one person', async () => {
    const contractId = oid();
    await assert.rejects(() => new Induction({ contractId, date: days(0) }).validate(), /Choose the employee or subcontractor/);
    await assert.rejects(() => new Induction({ contractId, date: days(0), employeeId: oid(), subcontractorId: oid() }).validate(), /not both/);
    await assert.rejects(() => new Induction({ date: days(0), employeeId: oid() }).validate(), /contractId/);
    await assert.rejects(() => new Induction({ contractId, date: days(0), employeeId: oid(), expiryDate: days(-1) }).validate(), /before the induction/);
    await new Induction({ contractId, date: days(0), employeeId: oid(), topics: ['PPE'] }).validate();
  });
});

describe('induction access', () => {
  it('Site Managers and Supervisors hold H&S edit on their own sites only', () => {
    for (const r of ['siteManager', 'supervisor']) {
      assert.ok(rbac.hasGroup(as(r), 'healthSafety', 'edit', { project: true }), r);
      assert.ok(!rbac.hasGroup(as(r), 'healthSafety', 'edit'), r);
    }
    assert.ok(rbac.hasGroup(as('healthSafetyAdvisor'), 'healthSafety', 'edit'));
    assert.deepEqual(accessGroups.PROJECT_SCOPE_FIELDS.induction, { field: 'contractId', set: 'contractIds' });
  });

  it('the record page opens for site roles and H&S; the overviews only for H&S', () => {
    for (const r of ['siteManager', 'supervisor', 'healthSafetyAdvisor']) assert.ok(rbac.routeAccess['/inductions/record'].includes(r), r);
    assert.ok(!rbac.routeAccess['/inductions/record'].includes('fleetManager'));
    assert.ok(rbac.routeAccess['/overview/induction'].includes('healthSafetyAdvisor'));
    assert.ok(!rbac.routeAccess['/overview/induction'].includes('siteManager'));
    assert.equal(rbac.roleModelAccess.employee.induction, 'r:own,l:own');
    assert.equal(rbac.roleModelAccess.subcontractor.induction, 'r:own,l:own');
  });

  it('is on the Health & Safety overview', () => {
    assert.ok(overviews.getArea('healthSafety').children.includes('induction'));
    assert.ok(overviews.getNode('induction'));
    assert.deepEqual(overviews.validate(), []);
  });

  it('writes on every site for admin and H&S, on their sites for site roles', async () => {
    assert.equal(await ctrl.writeScopeFor({ user: { _id: oid(), role: 'admin' } }), null);
    assert.equal(await ctrl.writeScopeFor({ user: as('healthSafetyAdvisor') }), null);
    const sets = { contractIds: [oid()] };
    assert.equal(await ctrl.writeScopeFor({ user: as('siteManager'), _projectScope: Promise.resolve(sets) }), sets);
  });
});

describe('induction form', () => {
  const siteA = oid(); const siteB = oid(); const emp = oid(); const sub = oid();
  const options = {
    contracts: [{ _id: siteA, title: 'Site A' }],
    people: [{ value: `e:${emp}`, label: 'Employee', contractIds: [String(siteA)] }, { value: `s:${sub}`, label: 'Sub', contractIds: [String(siteA)] }],
  };
  const body = (over = {}) => ({ person: `e:${emp}`, contractId: String(siteA), date: '2026-11-02', topics: ['PPE', 'Site hazards', 'Not a topic'], acknowledged: 'on', ...over });
  const user = { _id: oid() };

  it('builds the induction from a good form', () => {
    const { doc, error } = ctrl.parseForm(body(), options, user);
    assert.equal(error, undefined);
    assert.equal(String(doc.employeeId), String(emp));
    assert.deepEqual(doc.topics, ['PPE', 'Site hazards']);
    assert.equal(doc.acknowledged, true);
    assert.equal(doc.inductedBy, user._id);
    assert.equal(doc.expiryDate, null);
  });

  it('refuses another site, someone not on the site, and bad dates or topics', () => {
    const err = (over) => ctrl.parseForm(body(over), options, user).error;
    assert.match(err({ contractId: String(siteB) }), /isn't one of your sites/);
    assert.match(err({ person: `e:${oid()}` }), /isn't assigned to this site/);
    assert.match(err({ person: 'x' }), /Choose who/);
    assert.match(err({ date: '2026-02-30' }), /date of the induction/);
    assert.match(err({ expiryDate: '2026-11-01' }), /before the induction/);
    assert.match(err({ topics: [] }), /at least one topic/);
    assert.match(err({ personName: 'Someone' }), /only for someone a subcontractor sends/);
  });

  it('takes an operative name for a subcontractor', () => {
    const { doc } = ctrl.parseForm(body({ person: `s:${sub}`, personName: ' Operative ', expiryDate: '2027-11-02' }), options, user);
    assert.equal(String(doc.subcontractorId), String(sub));
    assert.equal(doc.personName, 'Operative');
    assert.ok(doc.expiryDate instanceof Date);
  });

  it('the page renders the form, and explains when there are no sites', async () => {
    const locals = { title: 't', csrfToken: 'c', topics: INDUCTION_TOPICS, sitesOnly: true, today: '2026-11-08', recent: [] };
    const html = await ejs.renderFile(view, { ...locals, ...options }, { async: true });
    assert.match(html, /action="\/inductions\/record"/);
    assert.match(html, new RegExp(`value="e:${emp}"`));
    assert.match(html, /Employee — Site A/);
    assert.match(html, /name="topics" value="PPE"/);
    const none = await ejs.renderFile(view, { ...locals, contracts: [], people: [] }, { async: true });
    assert.match(none, /id="no-sites"/);
    assert.doesNotMatch(none, /<form method="POST"/);
  });
});

describe('re-induction reminders', () => {
  let saved; let ensureCalls; let emails;
  const contractId = oid(); const sm = oid(); const emp = oid();

  beforeEach(() => {
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST, ensure: taskService.ensureSystemTask, resolve: taskService.resolveStaleSystemTasks, enqueue: notificationService.enqueue };
    ensureCalls = []; emails = [];
    taskService.ensureSystemTask = mock.fn(async (a) => { ensureCalls.push(a); return { created: 1, updated: 0, skipped: 0 }; });
    taskService.resolveStaleSystemTasks = mock.fn(async () => 0);
    notificationService.enqueue = mock.fn(async (n) => { emails.push(n); return {}; });
    const chain = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
    mdb.INTERNAL = {
      induction: { find: () => chain([{ _id: oid(), uuid: 'i1', contractId, employeeId: emp, expiryDate: days(5) }]) },
      trainingRecord: { find: () => chain([]) },
      employee: { find: () => chain([{ _id: emp, name: 'Employee One' }]) },
      contract: { find: () => chain([{ _id: contractId, title: 'Site A', siteManagers: [sm] }]) },
      user: {
        find: () => chain([{ _id: 'admin1', email: 'a@example.test', emailVerified: true }]),
        findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'emp1', email: 'e@example.test' }) }) }),
      },
    };
    mdb.REST = {};
  });

  afterEach(() => {
    mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST;
    taskService.ensureSystemTask = saved.ensure; taskService.resolveStaleSystemTasks = saved.resolve;
    notificationService.enqueue = saved.enqueue;
  });

  it('goes to H&S and the site managers, and tells the person', async () => {
    await svc.checkExpiriesAndCreateTasks();
    assert.equal(ensureCalls.length, 1);
    assert.equal(ensureCalls[0].title, '[EXPIRING] Site induction (Site A) – Employee One');
    assert.ok(ensureCalls[0].systemKey.startsWith('induction:'));
    assert.deepEqual(ensureCalls[0].userIds.map(String), ['admin1', String(sm)]);
    assert.ok(emails.some((e) => e.to === 'e@example.test' && /due again soon/.test(e.subject)));
    // each source closes its own stale tasks
    assert.deepEqual(taskService.resolveStaleSystemTasks.mock.calls.map((c) => c.arguments[0]), ['training:', 'induction:']);
  });
});
