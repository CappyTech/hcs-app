import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';
import ramsModel from '../mongoose/models/mongoose/INTERNAL/rams.js';
import briefingModel from '../mongoose/models/mongoose/INTERNAL/ramsBriefing.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import overviews from '../mongoose/config/overviews/index.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';
import notificationService from '../services/notificationService.js';
import svc from '../mongoose/services/healthSafetyComplianceService.js';
import { parseBrief } from '../mongoose/controllers/ramsController.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Rams = mongoose.models.ramsTest || mongoose.model('ramsTest', ramsModel.schema.clone());
const Briefing = mongoose.models.ramsBriefingTest || mongoose.model('ramsBriefingTest', briefingModel.schema.clone());
const oid = () => new mongoose.Types.ObjectId();
const days = (n) => new Date(Date.now() + n * 864e5);
const view = path.join(root, 'mongoose/views/tailwindcss/healthSafety/ramsBrief.ejs');
const as = (jobRole, role = 'employee') => ({ _id: oid(), role, roles: jobRole ? [jobRole] : [] });

describe('RAMS models', () => {
  it('a RAMS needs a site and a title; approving fills the approved date', async () => {
    await assert.rejects(() => new Rams({ title: 'Work' }).validate(), /contractId/);
    await assert.rejects(() => new Rams({ contractId: oid() }).validate(), /title/);
    await assert.rejects(() => new Rams({ contractId: oid(), title: 'Work', documentUrl: 'javascript:alert(1)' }).validate(), /http/);
    const r = new Rams({ contractId: oid(), title: 'Work', status: 'Approved' });
    await r.validate();
    assert.ok(r.approvedDate instanceof Date);
    assert.equal(r.version, 1);
  });

  it('a briefing is for one person on one RAMS', async () => {
    await assert.rejects(() => new Briefing({ ramsId: oid(), contractId: oid(), date: days(0) }).validate(), /Choose the employee/);
    await assert.rejects(() => new Briefing({ ramsId: oid(), contractId: oid(), date: days(0), employeeId: oid(), subcontractorId: oid() }).validate(), /not both/);
    await new Briefing({ ramsId: oid(), contractId: oid(), date: days(0), employeeId: oid() }).validate();
  });
});

describe('RAMS access', () => {
  it('both models are site-scoped and in the Health & Safety group', () => {
    for (const m of ['rams', 'ramsBriefing']) {
      assert.ok(accessGroups.groups.healthSafety.models.includes(m), m);
      assert.deepEqual(accessGroups.PROJECT_SCOPE_FIELDS[m], { field: 'contractId', set: 'contractIds' });
    }
    assert.ok(accessGroups.PROJECT_SCOPE_ROUTES.has('/rams/brief'));
  });

  it('the briefing page opens for site roles and H&S, not others', () => {
    for (const r of ['siteManager', 'supervisor', 'healthSafetyAdvisor']) assert.ok(rbac.routeAccess['/rams/brief'].includes(r), r);
    assert.ok(!rbac.routeAccess['/rams/brief'].includes('fleetManager'));
    assert.ok(!rbac.routeAccess['/overview/rams'].includes('siteManager'));
    assert.equal(rbac.roleModelAccess.employee.ramsBriefing, 'r:own,l:own');
    assert.equal(rbac.roleModelAccess.employee.rams, undefined);
  });

  it('is on the Health & Safety overview', () => {
    const area = overviews.getArea('healthSafety');
    assert.deepEqual(area.children, ['trainingRecord', 'induction', 'rams', 'ramsBriefing']);
    assert.ok(overviews.getNode('rams') && overviews.getNode('ramsBriefing'));
    assert.deepEqual(overviews.validate(), []);
  });
});

describe('generated list pages', () => {
  let listRoutes;
  before(async () => {
    process.env.ENCRYPTION_KEY ||= 'test-key';
    // Register every model on an unopened connection so the list controller
    // and router generate their handlers without a database.
    for (const ns of ['REST', 'INTERNAL']) {
      const conn = mongoose.createConnection();
      const dir = path.join(root, 'mongoose/models/mongoose', ns);
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const { modelName, schema } = (await import(pathToFileURL(path.join(dir, f)).href)).default;
        if (!mdb[ns][modelName]) mdb[ns][modelName] = conn.model(modelName, schema);
      }
    }
    listRoutes = (await import('../mongoose/routes/listRoutes.js')).default;
  });

  const guardFor = (p) => {
    const layer = listRoutes.stack.find((l) => l.route?.path === p);
    assert.ok(layer, `no list route ${p}`);
    return layer.route.stack[0].handle;
  };
  const pass = (p, user) => new Promise((resolve) => {
    guardFor(p)({ user, path: p }, {}, (err) => resolve(!err));
  });

  it('employees and subcontractors reach their own H&S lists', async () => {
    for (const p of ['/trainingrecords', '/inductions', '/ramsbriefings']) {
      assert.ok(await pass(p, as(null, 'employee')), `employee ${p}`);
      assert.ok(await pass(p, as(null, 'subcontractor')), `subcontractor ${p}`);
      assert.ok(!(await pass(p, as(null, 'client'))), `client ${p}`);
    }
  });

  it('RAMS lists at /rams for H&S and site roles, not a plain employee', async () => {
    assert.ok(await pass('/rams', as('healthSafetyAdvisor')));
    assert.ok(await pass('/rams', as('siteManager')));
    assert.ok(!(await pass('/rams', as(null, 'employee'))));
  });
});

describe('briefing form', () => {
  const site = oid(); const other = oid(); const emp = oid(); const sub = oid();
  const rams = { _id: oid(), uuid: 'u', title: 'Hedge cutting', version: 2, contractId: site };
  const options = {
    contracts: [{ _id: site, title: 'Site A' }],
    people: [
      { value: `e:${emp}`, label: 'Employee', contractIds: [String(site)] },
      { value: `s:${sub}`, label: 'Sub', contractIds: [String(site)] },
      { value: `e:${oid()}`, label: 'Elsewhere', contractIds: [String(other)] },
    ],
  };
  const user = { _id: oid() };

  it('saves one briefing per person, with the RAMS version and site', () => {
    const { docs, error } = parseBrief({ date: '2026-11-03', people: [`e:${emp}`, `s:${sub}`, `e:${emp}`] }, rams, options, user);
    assert.equal(error, undefined);
    assert.equal(docs.length, 2);
    assert.equal(docs[0].ramsVersion, 2);
    assert.equal(docs[0].contractId, site);
    assert.equal(String(docs[1].subcontractorId), String(sub));
    assert.equal(docs[0].briefedBy, user._id);
  });

  it('refuses no RAMS, no one ticked, a bad date, and someone from another site', () => {
    assert.match(parseBrief({ date: '2026-11-03', people: [`e:${emp}`] }, null, options, user).error, /approved RAMS/);
    assert.match(parseBrief({ date: '2026-11-03' }, rams, options, user).error, /Tick who/);
    assert.match(parseBrief({ date: 'yesterday', people: [`e:${emp}`] }, rams, options, user).error, /date/);
    assert.match(parseBrief({ date: '2026-11-03', people: [options.people[2].value] }, rams, options, user).error, /isn't assigned/);
  });

  it('the page offers RAMS, then the people on that site', async () => {
    const base = { title: 't', csrfToken: 'c', contracts: options.contracts, sitesOnly: true, today: '2026-11-08', briefed: [] };
    const none = await ejs.renderFile(view, { ...base, ramsList: [], rams: null, people: [] }, { async: true });
    assert.match(none, /id="no-rams"/);
    const pick = await ejs.renderFile(view, { ...base, ramsList: [rams], rams: null, people: [] }, { async: true });
    assert.match(pick, /Site A — Hedge cutting v2/);
    assert.doesNotMatch(pick, /method="POST"/);
    const tick = await ejs.renderFile(view, { ...base, ramsList: [rams], rams, people: options.people.slice(0, 2),
      briefed: [{ employeeId: { name: 'Old Hand' }, ramsVersion: 1, date: days(-3) }] }, { async: true });
    assert.match(tick, /name="people" value="e:/);
    assert.match(tick, /name="rams" value="u"/);
    assert.match(tick, /Old Hand \(v1\)/);
  });
});

describe('RAMS review reminders', () => {
  let saved; let ensureCalls; let emails; let ramsQuery;
  const contractId = oid(); const sm = oid();

  beforeEach(() => {
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST, ensure: taskService.ensureSystemTask, resolve: taskService.resolveStaleSystemTasks, enqueue: notificationService.enqueue };
    ensureCalls = []; emails = [];
    taskService.ensureSystemTask = mock.fn(async (a) => { ensureCalls.push(a); return { created: 1, updated: 0, skipped: 0 }; });
    taskService.resolveStaleSystemTasks = mock.fn(async () => 0);
    notificationService.enqueue = mock.fn(async (n) => { emails.push(n); return {}; });
    const chain = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
    mdb.INTERNAL = {
      rams: { find: (q) => { ramsQuery = q; return chain([{ _id: oid(), uuid: 'r1', title: 'Hedge cutting', version: 2, contractId, reviewDate: days(-2) }]); } },
      contract: { find: () => chain([{ _id: contractId, title: 'Site A', siteManagers: [sm] }]) },
      user: { find: () => chain([{ _id: 'admin1', email: 'a@example.test', emailVerified: true }]), findOne: () => { throw new Error('no holder lookup for RAMS'); } },
    };
    mdb.REST = {};
  });

  afterEach(() => {
    mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST;
    taskService.ensureSystemTask = saved.ensure; taskService.resolveStaleSystemTasks = saved.resolve;
    notificationService.enqueue = saved.enqueue;
  });

  it('reminds H&S and the site managers about approved RAMS past review', async () => {
    const stats = await svc.checkExpiriesAndCreateTasks();
    assert.equal(stats.errors, 0);
    assert.equal(ramsQuery.status, 'Approved');
    assert.ok(ramsQuery.reviewDate.$lte instanceof Date);
    assert.equal(ensureCalls.length, 1);
    assert.equal(ensureCalls[0].title, '[EXPIRED] RAMS review: Hedge cutting v2 – Site A');
    assert.ok(ensureCalls[0].systemKey.startsWith('rams:'));
    assert.deepEqual(ensureCalls[0].userIds.map(String), ['admin1', String(sm)]);
    assert.deepEqual(emails.map((e) => e.to), ['a@example.test'], 'only the summary; RAMS has no person');
  });
});
