import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';
import accidentModel, { HEALTH_FIELDS } from '../mongoose/models/mongoose/INTERNAL/accidentReport.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import overviews from '../mongoose/config/overviews/index.js';
import engine from '../mongoose/services/overviewEngine.js';
import { redactEntry, REDACTED } from '../mongoose/services/auditPlugin.js';
import ctrl from '../mongoose/controllers/accidentController.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';
import notificationService from '../services/notificationService.js';
import svc from '../mongoose/services/healthSafetyComplianceService.js';

const Accident = mongoose.models.accidentTest || mongoose.model('accidentTest', accidentModel.schema.clone());
const oid = () => new mongoose.Types.ObjectId();
const view = (n) => fileURLToPath(new URL(`../mongoose/views/tailwindcss/healthSafety/${n}.ejs`, import.meta.url));
const as = (jobRole, role = 'employee', extra = {}) => ({ _id: oid(), role, roles: jobRole ? [jobRole] : [], ...extra });

describe('accident book model', () => {
  it('needs when, what, where and a description; closing stamps the date', async () => {
    const base = { occurredAt: new Date(Date.now() - 3600e3), category: 'Near miss', description: 'Slipped ladder', reportedBy: oid() };
    await assert.rejects(() => new Accident({ ...base, location: '' }).validate(), /Say where it happened/);
    await assert.rejects(() => new Accident({ ...base, location: 'Yard', occurredAt: new Date(Date.now() + 864e5) }).validate(), /future/);
    await assert.rejects(() => new Accident({ ...base, location: 'Yard', category: 'Other' }).validate(), /category/);
    const closed = new Accident({ ...base, contractId: oid(), status: 'Closed' });
    await closed.validate();
    assert.ok(closed.closedAt instanceof Date);
    closed.status = 'Open';
    await closed.validate();
    assert.equal(closed.closedAt, null);
  });

  it('keeps health fields out of the audit trail', () => {
    assert.deepEqual(accidentModel.schema.get('auditRedact'), HEALTH_FIELDS);
    const fields = new Set(HEALTH_FIELDS);
    const entry = redactEntry({
      op: 'update',
      before: { description: 'old', status: 'Open', bodyPart: '' },
      after: { description: 'new', status: 'Closed', bodyPart: 'hand' },
      changes: { description: { from: 'old', to: 'new' }, status: { from: 'Open', to: 'Closed' }, bodyPart: { from: '', to: 'hand' } },
    }, fields);
    assert.equal(entry.before.description, REDACTED);
    assert.equal(entry.after.bodyPart, REDACTED);
    assert.equal(entry.before.bodyPart, '');
    assert.deepEqual(entry.changes.description, { from: REDACTED, to: REDACTED });
    assert.deepEqual(entry.changes.bodyPart, { from: '', to: REDACTED });
    assert.deepEqual(entry.changes.status, { from: 'Open', to: 'Closed' }, 'other fields untouched');
    const created = redactEntry({ op: 'create', after: { description: 'x' } }, fields);
    assert.equal('before' in created, false);
  });
});

describe('accident book access', () => {
  it('is in no group, so no view grant reads it; generic pages stay admin-only', () => {
    for (const g of Object.values(accessGroups.groups)) assert.ok(!g.models.includes('accidentReport'));
    for (const r of ['healthSafetyAdvisor', 'director', 'contractsManager', 'siteManager']) {
      assert.equal(rbac.canAccess([r], 'accidentReport', 'r').allowed, false, r);
      assert.equal(rbac.canAccess([r], 'accidentReport', 'l').allowed, false, r);
    }
    assert.equal(rbac.canAccess(['employee'], 'accidentReport', 'r').allowed, false);
  });

  it('the book opens at H&S approve: Advisor and Director, not Contracts Manager or site roles', () => {
    assert.ok(ctrl.canReadBook(as('healthSafetyAdvisor')));
    assert.ok(ctrl.canReadBook(as('director')));
    assert.ok(ctrl.canReadBook({ _id: oid(), role: 'admin', roles: [] }));
    for (const r of ['contractsManager', 'siteManager', 'supervisor', 'fleetManager', null]) assert.ok(!ctrl.canReadBook(as(r)), String(r));
    for (const r of ['healthSafetyAdvisor', 'director']) assert.ok(rbac.routeAccess['/accidents'].includes(r), r);
    assert.ok(!rbac.routeAccess['/accidents'].includes('contractsManager'));
    assert.equal(rbac.matchRoutePattern('/accident-report'), null, 'reporting is not under the /accidents rule');
  });

  it('anyone who works for the company can report; clients and HMRC cannot', () => {
    for (const u of [as(null, 'employee'), as(null, 'subcontractor'), as(null, 'accountant'), as('siteManager', 'none')]) assert.ok(ctrl.canReport(u));
    for (const u of [as(null, 'client'), as(null, 'hmrc'), as(null, 'none'), null]) assert.ok(!ctrl.canReport(u));
  });

  it('the overview node shows only to those who can open the book', () => {
    const node = overviews.getNode('accidentReport');
    assert.equal(node.listRoute, '/accidents');
    assert.deepEqual(overviews.validate(), []);
    const req = (user) => ({ user });
    assert.ok(engine.canSeeNode(req(as('healthSafetyAdvisor')), node));
    assert.ok(!engine.canSeeNode(req(as('contractsManager')), node));
    assert.ok(!engine.canSeeNode(req(as(null, 'employee')), node));
  });
});

describe('accident report form', () => {
  const site = oid();
  const good = { occurredAt: '2026-11-02T09:30', category: 'Injury', description: 'Cut hand on saw', who: 'me', contractId: String(site), injuryDetails: 'Cut', treatment: 'First aid on site' };

  it('records the reporter as the person hurt, through their linked record', () => {
    const emp = oid();
    const { doc, error } = ctrl.parseReport(good, as(null, 'employee', { employeeId: emp }), [site]);
    assert.equal(error, undefined);
    assert.equal(doc.employeeId, emp);
    assert.equal(String(doc.contractId), String(site));
    assert.equal(doc.treatment, 'First aid on site');
    const sub = oid();
    assert.equal(ctrl.parseReport(good, as(null, 'subcontractor', { subcontractorId: sub }), [site]).doc.subcontractorId, sub);
  });

  it('refuses the incomplete or the impossible', () => {
    const u = as(null, 'employee');
    const err = (over) => ctrl.parseReport({ ...good, ...over }, u, [site]).error;
    assert.match(err({ occurredAt: '2026-02-30T09:30' }), /when it happened/);
    assert.match(err({ occurredAt: '2999-01-01T09:30' }), /future/);
    assert.match(err({ category: 'Oops' }), /what kind/);
    assert.match(err({ description: '  ' }), /Describe/);
    assert.match(err({ contractId: String(oid()) }), /site from the list/);
    assert.match(err({ contractId: '', location: '' }), /Say where/);
    assert.match(err({ who: 'other', personName: '' }), /name of the person/);
    assert.match(err({ who: 'nobody' }), /injury needs the person/);
    assert.match(err({ who: undefined }), /who was hurt/);
    assert.equal(err({ who: 'nobody', category: 'Near miss', contractId: '', location: 'Yard' }), undefined);
  });

  it('the investigation form keeps RIDDOR consistent', () => {
    const u = as('healthSafetyAdvisor');
    const ok = ctrl.parseInvestigation({ status: 'Closed', riddorReportable: 'yes', riddorReference: 'REF', riddorReportedDate: '2026-11-05', investigation: 'x' }, u);
    assert.equal(ok.update.riddorReportable, true);
    assert.equal(ok.update.reviewedBy, u._id);
    assert.equal(ctrl.parseInvestigation({ status: 'Open', riddorReportable: '' }, u).update.riddorReportable, null);
    assert.match(ctrl.parseInvestigation({ status: 'Open', riddorReportable: 'no', riddorReportedDate: '2026-11-05' }, u).error, /Only a RIDDOR-reportable/);
    assert.match(ctrl.parseInvestigation({ status: 'Gone' }, u).error, /status/);
    assert.equal(ctrl.parseInvestigation({ status: 'Open', riddorReportable: 'no', riddorReference: 'X' }, u).update.riddorReference, '');
  });

  it('the pages render', async () => {
    const locals = { title: 't', csrfToken: 'c' };
    const report = await ejs.renderFile(view('accidentReport'), { ...locals, contracts: [{ _id: site, title: 'Site A' }], categories: ['Injury'], treatments: ['Not known'], now: '2026-11-08T10:00' }, { async: true });
    assert.match(report, /action="\/accident-report"/);
    assert.match(report, /call 999/);
    const mine = await ejs.renderFile(view('accidentMine'), { ...locals, rows: [{ occurredAt: new Date(), category: 'Near miss', location: 'Yard', status: 'Open', description: 'SECRET' }] }, { async: true });
    assert.match(mine, /Near miss/);
    assert.doesNotMatch(mine, /SECRET/, 'my reports show no details');
    const book = await ejs.renderFile(view('accidentBook'), { ...locals, rows: [{ uuid: 'u1', occurredAt: new Date(), category: 'Injury', personName: 'P', status: 'Open', riddorReportable: true }], filters: { status: '', category: '', riddor: '' }, categories: ['Injury'], statuses: ['Open'] }, { async: true });
    assert.match(book, /href="\/accidents\/u1"/);
    assert.match(book, /To report/);
    const entry = await ejs.renderFile(view('accidentEntry'), { ...locals, statuses: ['Open', 'Closed'], subName: '',
      entry: { uuid: 'u1', occurredAt: new Date(), category: 'Injury', description: 'What', personName: 'P', status: 'Open', riddorReportable: null, createdAt: new Date() } }, { async: true });
    assert.match(entry, /action="\/accidents\/u1"/);
    assert.match(entry, /<option value="" selected>Not decided/);
  });
});

describe('RIDDOR reminders', () => {
  let saved; let ensureCalls; let emails; let userQueries;
  const occurred = new Date(Date.now() - 10 * 864e5);

  beforeEach(() => {
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST, ensure: taskService.ensureSystemTask, resolve: taskService.resolveStaleSystemTasks, enqueue: notificationService.enqueue };
    ensureCalls = []; emails = []; userQueries = [];
    taskService.ensureSystemTask = mock.fn(async (a) => { ensureCalls.push(a); return { created: 1, updated: 0, skipped: 0 }; });
    taskService.resolveStaleSystemTasks = mock.fn(async () => 0);
    notificationService.enqueue = mock.fn(async (n) => { emails.push(n); return {}; });
    const chain = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
    mdb.INTERNAL = {
      accidentReport: { find: () => chain([
        { _id: oid(), uuid: 'a1', category: 'Injury', occurredAt: occurred, personName: 'Hurt Person', riddorReportable: true, riddorReportedDate: null },
        { _id: oid(), uuid: 'a2', category: 'Injury', occurredAt: new Date(), riddorReportable: true, riddorReportedDate: null },
      ]) },
      user: {
        find: (q) => {
          userQueries.push(q);
          const roles = q.$or[1]?.roles?.$in || [];
          // Edit-level reminder list vs the book readers (approve).
          return chain(roles.includes('healthSafetyAdvisor')
            ? [{ _id: 'admin1', email: 'a@example.test', emailVerified: true }, { _id: 'hs1', email: 'h@example.test', emailVerified: true }]
            : [{ _id: 'admin1', email: 'a@example.test', emailVerified: true }]);
        },
        findOne: () => { throw new Error('no person lookup for the accident book'); },
      },
    };
    mdb.REST = {};
  });

  afterEach(() => {
    mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST;
    taskService.ensureSystemTask = saved.ensure; taskService.resolveStaleSystemTasks = saved.resolve;
    notificationService.enqueue = saved.enqueue;
  });

  it('only entries within 30 days of their deadline; book readers only; no names', async () => {
    const stats = await svc.checkExpiriesAndCreateTasks();
    assert.equal(stats.errors, 0);
    assert.equal(ensureCalls.length, 2, 'both deadlines (5 and 15 days away) fall inside 30 days');
    for (const c of ensureCalls) {
      assert.ok(c.systemKey.startsWith('riddor:'));
      assert.doesNotMatch(c.title + c.description, /Hurt Person/);
      assert.match(c.title, /^\[EXPIRING\] RIDDOR report: injury on \d{4}-\d{2}-\d{2} – accident book$/);
    }
    const approveRoles = svc.healthSafetyJobRoles('approve');
    assert.ok(approveRoles.includes('healthSafetyAdvisor') && approveRoles.includes('director'));
    assert.ok(!approveRoles.includes('contractsManager'));
    const riddorMails = emails.filter((e) => /RIDDOR/.test(e.subject));
    assert.deepEqual(riddorMails.map((e) => e.to).sort(), ['a@example.test', 'h@example.test']);
    assert.ok(emails.every((e) => !/Hurt Person/.test(e.text)));
  });
});
