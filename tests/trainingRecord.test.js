import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import trainingModel from '../mongoose/models/mongoose/INTERNAL/trainingRecord.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import listConfig from '../mongoose/config/listControllerConfig.js';
import crudConfig from '../mongoose/config/CRUDControllerConfig.js';
import overviews from '../mongoose/config/overviews/index.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import taskService from '../mongoose/services/taskService.js';
import notificationService from '../services/notificationService.js';
import svc from '../mongoose/services/healthSafetyComplianceService.js';

const Training = mongoose.models.trainingRecordTest
  || mongoose.model('trainingRecordTest', trainingModel.schema.clone());
const oid = () => new mongoose.Types.ObjectId();
const days = (n) => new Date(Date.now() + n * 864e5);

describe('trainingRecord model', () => {
  it('belongs to an employee or a subcontractor, not both or neither', async () => {
    await assert.rejects(() => new Training({ type: 'CSCS card' }).validate(), /Choose the employee or subcontractor/);
    await assert.rejects(() => new Training({ type: 'CSCS card', employeeId: oid(), subcontractorId: oid() }).validate(), /not both/);
    await new Training({ type: 'CSCS card', employeeId: oid() }).validate();
    await new Training({ type: 'IPAF', subcontractorId: oid(), personName: 'Operative' }).validate();
  });

  it('refuses an expiry before the issue date and an unknown type', async () => {
    await assert.rejects(() => new Training({ type: 'IPAF', employeeId: oid(), issuedDate: days(0), expiryDate: days(-1) }).validate(), /before the issue date/);
    await assert.rejects(() => new Training({ type: 'Juggling', employeeId: oid() }).validate(), /type/);
  });
});

describe('training records access', () => {
  it('the Health & Safety group holds the model; the H&S Advisor records, others read their own', () => {
    assert.ok(accessGroups.groups.healthSafety.models.includes('trainingRecord'));
    const advisor = rbac.roleModelAccess.healthSafetyAdvisor.trainingRecord;
    for (const op of ['c', 'r', 'u', 'l']) assert.match(advisor, new RegExp(`(^|,)${op}(,|$)`), op);
    assert.doesNotMatch(advisor, /(^|,)d(,|$)/);
    assert.equal(rbac.roleModelAccess.employee.trainingRecord, 'r:own,l:own');
    assert.equal(rbac.roleModelAccess.subcontractor.trainingRecord, 'r:own,l:own');
    assert.equal(rbac.ownershipFields.employee.modelFields.trainingRecord, 'employeeId');
    assert.equal(rbac.ownershipFields.subcontractor.modelFields.trainingRecord, 'subcontractorId');
  });

  it('the overview routes open for the H&S Advisor, not for a Fleet Manager', () => {
    for (const r of ['/overview/healthSafety', '/overview/trainingRecord']) {
      assert.ok(rbac.routeAccess[r].includes('healthSafetyAdvisor'), r);
      assert.ok(!rbac.routeAccess[r].includes('fleetManager'), r);
    }
  });

  it('has list, CRUD and overview config', () => {
    assert.equal(listConfig.trainingRecord.listPath, '/trainingrecords');
    assert.deepEqual(crudConfig.trainingRecord.xorGroups, [['employeeId', 'subcontractorId']]);
    assert.equal(crudConfig.trainingRecord.middleware, undefined);
    const area = overviews.getArea('healthSafety');
    assert.ok(area.children.includes('trainingRecord'));
    assert.ok(overviews.getNode('trainingRecord'));
    assert.deepEqual(overviews.validate(), []);
  });

  it('reminders go to job roles with H&S at edit on every site, not project-scoped viewers', () => {
    const roles = svc.healthSafetyJobRoles();
    assert.ok(roles.includes('healthSafetyAdvisor'));
    assert.ok(!roles.includes('siteManager'));
  });
});

describe('training expiry reminders', () => {
  let ensureCalls; let emails; let saved;
  const employeeId = oid();
  const subId = oid();
  const records = () => [
    { _id: oid(), uuid: 'a', type: 'CSCS card', employeeId, expiryDate: days(-3) },
    { _id: oid(), uuid: 'b', type: 'IPAF', subcontractorId: subId, personName: 'Operative', expiryDate: days(10) },
  ];

  beforeEach(() => {
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST, ensure: taskService.ensureSystemTask, resolve: taskService.resolveStaleSystemTasks, enqueue: notificationService.enqueue };
    ensureCalls = []; emails = [];
    taskService.ensureSystemTask = mock.fn(async (args) => { ensureCalls.push(args); return { created: args.userIds.length, updated: 0, skipped: 0 }; });
    taskService.resolveStaleSystemTasks = mock.fn(async () => 0);
    notificationService.enqueue = mock.fn(async (n) => { emails.push(n); return {}; });
    const chain = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
    mdb.INTERNAL = {
      trainingRecord: { find: () => chain(records()) },
      employee: { find: () => chain([{ _id: employeeId, name: 'Employee One' }]) },
      user: {
        find: (q) => {
          assert.deepEqual(q.$or[0], { role: 'admin' });
          assert.ok(q.$or[1].roles.$in.includes('healthSafetyAdvisor'));
          return chain([{ _id: 'admin1', email: 'a@example.test', emailVerified: true }, { _id: 'hs1', email: 'h@example.test', emailVerified: true }]);
        },
        findOne: (q) => ({ select: () => ({ lean: async () => (q.employeeId ? { _id: 'emp1', email: 'e@example.test' } : null) }) }),
      },
    };
    mdb.REST = { supplier: { find: () => chain([{ _id: subId, Name: 'Sub Firm' }]) } };
  });

  afterEach(() => {
    mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST;
    taskService.ensureSystemTask = saved.ensure; taskService.resolveStaleSystemTasks = saved.resolve;
    notificationService.enqueue = saved.enqueue;
  });

  it('gives each expiring record one task for admins and H&S, and emails them and the holder', async () => {
    const stats = await svc.checkExpiriesAndCreateTasks();
    assert.equal(stats.errors, 0);
    assert.equal(ensureCalls.length, 2);
    assert.match(ensureCalls[0].title, /^\[EXPIRED\] CSCS card – Employee One$/);
    assert.match(ensureCalls[1].title, /^\[EXPIRING\] IPAF – Operative \(Sub Firm\)$/);
    assert.deepEqual(ensureCalls[0].userIds, ['admin1', 'hs1']);
    assert.ok(ensureCalls[0].systemKey.startsWith('training:'));

    const holder = emails.filter((e) => e.to === 'e@example.test');
    assert.equal(holder.length, 1, 'the employee is told; the named operative has no account');
    assert.match(holder[0].subject, /has expired/);
    const summaries = emails.filter((e) => /need attention/.test(e.subject));
    assert.deepEqual(summaries.map((e) => e.to).sort(), ['a@example.test', 'h@example.test']);
    assert.ok(emails.every((e) => e.category === 'health-safety'));
  });

  it('closes stale reminders only after a clean scan', async () => {
    taskService.ensureSystemTask = mock.fn(async () => { throw new Error('db down'); });
    const stats = await svc.checkExpiriesAndCreateTasks();
    assert.equal(stats.errors, 2);
    assert.equal(taskService.resolveStaleSystemTasks.mock.callCount(), 0);
  });
});
