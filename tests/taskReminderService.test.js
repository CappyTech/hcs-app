import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import notificationService from '../services/notificationService.js';
import { queueDueReminders } from '../mongoose/services/taskReminderService.js';

let tasks = [];
let users = [];
let enqueued = [];

function query(result) {
  const q = { select: () => q, sort: () => q, lean: () => Promise.resolve(result()) };
  return q;
}

function patch() {
  enqueued = [];
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    task: {
      find: (q) => query(() => tasks.filter((t) => !t.completed && t.dueDate && t.dueDate <= q.dueDate.$lte)),
    },
    user: {
      find: (q) => query(() => users.filter((u) => q._id.$in.includes(String(u._id)))),
    },
  };
  notificationService.enqueue = async (n) => { enqueued.push(n); };
}

const now = new Date('2026-10-09T09:00:00Z');
const hoursFrom = (h) => new Date(now.getTime() + h * 3600 * 1000);

describe('taskReminderService.queueDueReminders', () => {
  beforeEach(() => {
    users = [
      { _id: 'u1', email: 'u1@example.test', emailVerified: true },
      { _id: 'u2', email: 'u2@example.test', emailVerified: false },
    ];
    tasks = [];
    patch();
  });

  it('sends nothing when no tasks are due', async () => {
    assert.deepStrictEqual(await queueDueReminders(now), { users: 0, tasks: 0 });
    assert.equal(enqueued.length, 0);
  });

  it('sends one digest per user covering overdue and due-soon tasks', async () => {
    tasks = [
      { title: 'Late one', userId: 'u1', dueDate: hoursFrom(-48), priority: 'high' },
      { title: 'Due soon', userId: 'u1', dueDate: hoursFrom(5) },
      { title: 'Next week', userId: 'u1', dueDate: hoursFrom(24 * 7) },
      { title: 'Finished', userId: 'u1', dueDate: hoursFrom(-1), completed: true },
    ];
    const stats = await queueDueReminders(now);
    assert.deepStrictEqual(stats, { users: 1, tasks: 2 });
    assert.equal(enqueued.length, 1);
    const n = enqueued[0];
    assert.equal(n.typeKey, 'task-due');
    assert.equal(n.to, 'u1@example.test');
    assert.equal(n.dedupeKey, 'task-due:u1:2026-10-09');
    assert.match(n.subject, /1 overdue/);
    assert.match(n.text, /Overdue since .*Late one \(high priority\)/);
    assert.match(n.text, /Due .*Due soon/);
    assert.doesNotMatch(n.text, /Next week|Finished/);
  });

  it('skips users without a verified email', async () => {
    tasks = [{ title: 'Unverified', userId: 'u2', dueDate: hoursFrom(1) }];
    await queueDueReminders(now);
    assert.equal(enqueued.length, 0);
  });
});
