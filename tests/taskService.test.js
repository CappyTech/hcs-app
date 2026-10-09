import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/*
 * taskService requires mdb at top-level.
 * Patch the mdb singleton with a small in-memory task model so the
 * completion / recurrence / system-task rules run against real queries.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import __taskService from '../mongoose/services/taskService.js';
import notificationService from '../services/notificationService.js';

let store = [];
let users = {};
let enqueued = [];
let nextId = 1;

function matches(doc, query) {
  return Object.entries(query).every(([key, cond]) => {
    const val = doc[key];
    if (cond === null) return val === null || val === undefined;
    if (cond instanceof Date) return val instanceof Date && val.getTime() === cond.getTime();
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
          case '$ne': return arg === null ? val !== null && val !== undefined : val !== arg;
          case '$lte': return val != null && val <= arg;
          case '$lt': return val != null && val < arg;
          case '$gte': return val != null && val >= arg;
          case '$in': return arg.includes(val);
          case '$nin': return !arg.includes(val);
          case '$regex': return typeof val === 'string' && new RegExp(arg).test(val);
          default: throw new Error(`unsupported operator ${op}`);
        }
      });
    }
    return String(val) === String(cond);
  });
}

function query(result) {
  const q = {
    select: () => q, sort: () => q, limit: () => q,
    lean: () => Promise.resolve(typeof result === 'function' ? result() : result),
  };
  return q;
}

function applyUpdate(doc, update) {
  Object.assign(doc, update.$set || update);
}

function makeTaskModel() {
  const Task = function (data) {
    const doc = {
      _id: `t${nextId++}`, uuid: `uuid-${nextId}`, recurrence: 'none', priority: 'normal',
      source: 'manual', completed: false, completedAt: null, nextSpawnedAt: null, systemKey: null,
      ...data,
    };
    return {
      ...doc,
      async save() { store.push(doc); },
      toObject() { return { ...doc }; },
    };
  };
  Task.find = (q) => query(() => store.filter((d) => matches(d, q)).map((d) => ({ ...d })));
  Task.findOne = (q) => query(() => {
    const d = store.find((x) => matches(x, q));
    return d ? { ...d } : null;
  });
  Task.findOneAndUpdate = async (q, update) => {
    const d = store.find((x) => matches(x, q));
    if (!d) return null;
    applyUpdate(d, update);
    return { ...d, toObject: () => ({ ...d }) };
  };
  Task.updateOne = async (q, update) => {
    const d = store.find((x) => matches(x, q));
    if (d) applyUpdate(d, update);
    return { modifiedCount: d ? 1 : 0 };
  };
  Task.updateMany = async (q, update) => {
    const hits = store.filter((x) => matches(x, q));
    hits.forEach((d) => applyUpdate(d, update));
    return { modifiedCount: hits.length };
  };
  Task.countDocuments = async (q) => store.filter((d) => matches(d, q)).length;
  return Task;
}

function patchMdb() {
  store = [];
  enqueued = [];
  users = {
    u1: { _id: 'u1', email: 'u1@example.test', emailVerified: true },
    u2: { _id: 'u2', email: 'u2@example.test', emailVerified: true },
  };
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    task: makeTaskModel(),
    user: { findById: (id) => query(users[id] || null) },
  };
  notificationService.enqueue = async (n) => { enqueued.push(n); };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}

const {
  createTask,
  completeTask,
  getPendingTasksForUser,
  getTaskCountsForUser,
  processRecurringTasks,
  nextOccurrenceDate,
  ensureSystemTask,
  resolveStaleSystemTasks,
  advanceDate,
} = __taskService;

/* ── tests ─────────────────────────────────────────────────────────── */
describe('taskService', () => {
  beforeEach(patchMdb);

  describe('advanceDate (pure)', () => {
    it('advances daily', () => {
      const d = new Date('2025-06-01');
      assert.equal(advanceDate(d, 'daily').getDate(), 2);
    });

    it('advances weekly', () => {
      const d = new Date('2025-06-01');
      assert.equal(advanceDate(d, 'weekly').getDate(), 8);
    });

    it('advances monthly', () => {
      const d = new Date('2025-06-15');
      assert.equal(advanceDate(d, 'monthly').getMonth(), 6);
    });

    it('keeps month-end dates in shorter months instead of rolling over', () => {
      const d = new Date(2026, 0, 31);
      const feb = advanceDate(d, 'monthly', 1);
      assert.equal(feb.getMonth(), 1);
      assert.equal(feb.getDate(), 28);
      assert.equal(advanceDate(d, 'monthly', 2).getDate(), 31); // back to the 31st in March
    });

    it('returns same date for unknown recurrence', () => {
      const d = new Date('2025-06-01');
      assert.equal(advanceDate(d, 'none').getTime(), d.getTime());
    });

    it('uses current date when null', () => {
      const before = Date.now();
      assert.ok(advanceDate(null, 'daily').getTime() >= before);
    });
  });

  describe('nextOccurrenceDate', () => {
    it('is one period after the due date when completed on time', () => {
      const due = daysFromNow(2);
      const next = nextOccurrenceDate({ dueDate: due, recurrence: 'weekly' });
      assert.equal(next.getTime(), advanceDate(due, 'weekly').getTime());
    });

    it('skips periods that have already gone by', () => {
      const due = daysFromNow(-20);
      const next = nextOccurrenceDate({ dueDate: due, recurrence: 'weekly' });
      assert.equal(next.getTime(), advanceDate(due, 'weekly', 3).getTime()); // day +1
      assert.ok(next > new Date());
    });

    it('a daily task finished a day late is due again today', () => {
      const next = nextOccurrenceDate({ dueDate: daysFromNow(-1), recurrence: 'daily' });
      assert.equal(next.toDateString(), new Date().toDateString());
    });

    it('returns null for non-recurring tasks', () => {
      assert.equal(nextOccurrenceDate({ dueDate: new Date(), recurrence: 'none' }), null);
    });
  });

  describe('createTask', () => {
    it('creates with valid input', async () => {
      const result = await createTask({ title: 'Fix bug', description: 'desc', userId: 'u1' });
      assert.equal(result.title, 'Fix bug');
      assert.equal(store.length, 1);
    });

    it('throws when title missing', async () => {
      await assert.rejects(() => createTask({ userId: 'u1' }), { message: 'Task title is required.' });
    });

    it('throws when userId missing', async () => {
      await assert.rejects(() => createTask({ title: 'T' }), { message: 'userId is required for task creation.' });
    });

    it('throws when recurring without dueDate', async () => {
      await assert.rejects(
        () => createTask({ title: 'R', userId: 'u1', recurrence: 'daily' }),
        { message: 'Recurring tasks must include dueDate.' }
      );
    });

    it('allows recurring with dueDate', async () => {
      const result = await createTask({ title: 'Weekly', userId: 'u1', recurrence: 'weekly', dueDate: new Date() });
      assert.ok(result);
    });

    it('defaults recurrence to none', async () => {
      const result = await createTask({ title: 'One-off', userId: 'u1' });
      assert.equal(result.recurrence, 'none');
    });

    it('emails the assignee', async () => {
      await createTask({ title: 'Check scaffold', userId: 'u2', assignedBy: 'u1' });
      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0].typeKey, 'task-assigned');
      assert.equal(enqueued[0].to, 'u2@example.test');
    });

    it('does not email someone who assigned the task to themselves', async () => {
      await createTask({ title: 'Note to self', userId: 'u1', assignedBy: 'u1' });
      assert.equal(enqueued.length, 0);
    });

    it('does not email when notify is false', async () => {
      await createTask({ title: 'Quiet', userId: 'u2', notify: false });
      assert.equal(enqueued.length, 0);
    });
  });

  describe('completeTask', () => {
    it('throws when uuid missing', async () => {
      await assert.rejects(() => completeTask(null, 'u1'), { message: 'uuid and userId are required.' });
    });

    it('throws when userId missing', async () => {
      await assert.rejects(() => completeTask('uuid1', null), { message: 'uuid and userId are required.' });
    });

    it('returns null when not found', async () => {
      assert.equal(await completeTask('uuid1', 'u1'), null);
    });

    it('records when and by whom', async () => {
      const t = await createTask({ title: 'Done', userId: 'u1', notify: false });
      const result = await completeTask(t.uuid, 'u1');
      assert.equal(result.completed, true);
      assert.ok(result.completedAt instanceof Date);
      assert.equal(result.completedBy, 'u1');
    });

    it("cannot complete someone else's task", async () => {
      const t = await createTask({ title: 'Theirs', userId: 'u2', notify: false });
      assert.equal(await completeTask(t.uuid, 'u1'), null);
    });

    it('creates the next occurrence of a recurring task straight away', async () => {
      const due = daysFromNow(1);
      const t = await createTask({ title: 'Weekly check', userId: 'u1', recurrence: 'weekly', dueDate: due, notify: false });
      await completeTask(t.uuid, 'u1');

      const open = store.filter((d) => !d.completed);
      assert.equal(open.length, 1);
      assert.equal(open[0].title, 'Weekly check');
      assert.equal(open[0].dueDate.getTime(), advanceDate(due, 'weekly').getTime());
      assert.ok(store.find((d) => d._id === t._id).nextSpawnedAt);
      assert.equal(enqueued.length, 0); // continuing a series isn't a new assignment
    });

    it('completing one copy of a system task completes every copy', async () => {
      await ensureSystemTask({ systemKey: 'vehicle:v1:motExpiryDate:2026-11-01', title: '[EXPIRING] MOT', userIds: ['u1', 'u2'] });
      const mine = store.find((d) => d.userId === 'u1');
      await completeTask(mine.uuid, 'u1');
      assert.equal(store.filter((d) => !d.completed).length, 0);
      assert.equal(store.find((d) => d.userId === 'u2').completedBy, 'u1');
    });
  });

  describe('processRecurringTasks', () => {
    it('handles no recurring tasks', async () => {
      assert.deepStrictEqual(await processRecurringTasks(), { spawned: 0, errors: 0 });
    });

    it('creates a missing next occurrence for a completed recurring task', async () => {
      store.push({
        _id: 'r1', title: 'Daily thing', userId: 'u1', recurrence: 'daily', dueDate: daysFromNow(-1),
        completed: true, completedAt: new Date(), nextSpawnedAt: null, source: 'manual', priority: 'normal',
      });
      const stats = await processRecurringTasks();
      assert.equal(stats.spawned, 1);
      assert.equal(store.filter((d) => !d.completed).length, 1);
      // Idempotent: a second run finds nothing to do.
      assert.equal((await processRecurringTasks()).spawned, 0);
    });

    it('does not pile up copies of an overdue recurring task', async () => {
      store.push({
        _id: 'r2', title: 'Overdue daily', userId: 'u1', recurrence: 'daily', dueDate: daysFromNow(-5),
        completed: false, completedAt: null, nextSpawnedAt: null,
      });
      assert.equal((await processRecurringTasks()).spawned, 0);
      assert.equal(store.length, 1);
    });

    it('leaves recurring tasks completed before completion times were recorded', async () => {
      store.push({
        _id: 'r3', title: 'Legacy', userId: 'u1', recurrence: 'weekly', dueDate: daysFromNow(-30),
        completed: true, completedAt: null, nextSpawnedAt: null,
      });
      assert.equal((await processRecurringTasks()).spawned, 0);
    });
  });

  describe('ensureSystemTask', () => {
    const key = 'vehicle:v1:motExpiryDate:2026-11-01';

    it('creates one copy per user, without assignment emails', async () => {
      const r = await ensureSystemTask({ systemKey: key, title: '[EXPIRING] MOT – AB12', userIds: ['u1', 'u2'] });
      assert.equal(r.created, 2);
      assert.ok(store.every((d) => d.source === 'system' && d.systemKey === key));
      assert.equal(enqueued.length, 0);
    });

    it('does not duplicate on later runs', async () => {
      await ensureSystemTask({ systemKey: key, title: '[EXPIRING] MOT – AB12', userIds: ['u1'] });
      const r = await ensureSystemTask({ systemKey: key, title: '[EXPIRING] MOT – AB12', userIds: ['u1'] });
      assert.equal(r.created, 0);
      assert.equal(r.skipped, 1);
      assert.equal(store.length, 1);
    });

    it('is not re-created after someone completes it', async () => {
      await ensureSystemTask({ systemKey: key, title: '[EXPIRING] MOT – AB12', userIds: ['u1', 'u2'] });
      await completeTask(store[0].uuid, store[0].userId);
      const r = await ensureSystemTask({ systemKey: key, title: '[EXPIRED] MOT – AB12', userIds: ['u1', 'u2', 'u3'] });
      assert.equal(r.handled, true);
      assert.equal(r.created, 0);
      assert.equal(store.length, 2);
    });

    it('rewords open copies from EXPIRING to EXPIRED instead of adding a task', async () => {
      await ensureSystemTask({ systemKey: key, title: '[EXPIRING] MOT – AB12', priority: 'normal', userIds: ['u1'] });
      const r = await ensureSystemTask({ systemKey: key, title: '[EXPIRED] MOT – AB12', priority: 'high', userIds: ['u1'] });
      assert.equal(r.updated, 1);
      assert.equal(store.length, 1);
      assert.equal(store[0].title, '[EXPIRED] MOT – AB12');
      assert.equal(store[0].priority, 'high');
    });

    it('adopts open tasks created before system keys existed', async () => {
      store.push({ _id: 'old', userId: 'u1', title: '[EXPIRING] MOT – AB12', source: 'system', systemKey: null, completed: false });
      const r = await ensureSystemTask({
        systemKey: key, title: '[EXPIRED] MOT – AB12',
        legacyTitles: ['[EXPIRED] MOT – AB12', '[EXPIRING] MOT – AB12'], userIds: ['u1'],
      });
      assert.equal(r.adopted, 1);
      assert.equal(r.created, 0);
      assert.equal(store.length, 1);
      assert.equal(store[0].title, '[EXPIRED] MOT – AB12');
    });

    it('gives a newly added admin a copy of a still-open reminder', async () => {
      await ensureSystemTask({ systemKey: key, title: 'T', userIds: ['u1'] });
      const r = await ensureSystemTask({ systemKey: key, title: 'T', userIds: ['u1', 'u2'] });
      assert.equal(r.created, 1);
    });
  });

  describe('resolveStaleSystemTasks', () => {
    it('closes open reminders under the prefix that the scan no longer produced', async () => {
      await ensureSystemTask({ systemKey: 'vehicle:v1:mot:2026-11-01', title: 'old date', userIds: ['u1'] });
      await ensureSystemTask({ systemKey: 'vehicle:v1:mot:2027-11-01', title: 'new date', userIds: ['u1'] });
      await ensureSystemTask({ systemKey: 'employee:e1:contract.endDate:2026-12-01', title: 'hr', userIds: ['u1'] });

      const closed = await resolveStaleSystemTasks('vehicle:', new Set(['vehicle:v1:mot:2027-11-01']));
      assert.equal(closed, 1);
      const old = store.find((d) => d.title === 'old date');
      assert.equal(old.completed, true);
      assert.equal(old.autoResolved, true);
      assert.equal(store.find((d) => d.title === 'new date').completed, false);
      assert.equal(store.find((d) => d.title === 'hr').completed, false); // other prefix untouched
    });
  });

  describe('getPendingTasksForUser', () => {
    it('returns empty for null userId', async () => {
      assert.deepStrictEqual(await getPendingTasksForUser(null), []);
    });

    it('returns open tasks from DB', async () => {
      await createTask({ title: 'A', userId: 'u1', notify: false });
      await createTask({ title: 'B', userId: 'u1', notify: false });
      const result = await getPendingTasksForUser('u1');
      assert.equal(result.length, 2);
    });
  });

  describe('getTaskCountsForUser', () => {
    it('returns zeros for null userId', async () => {
      assert.deepStrictEqual(await getTaskCountsForUser(null), { total: 0, overdue: 0 });
    });

    it('returns counts from DB', async () => {
      await createTask({ title: 'Late', userId: 'u1', dueDate: daysFromNow(-2), notify: false });
      await createTask({ title: 'Later', userId: 'u1', dueDate: daysFromNow(2), notify: false });
      const result = await getTaskCountsForUser('u1');
      assert.deepStrictEqual(result, { total: 2, overdue: 1 });
    });
  });
});
