import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * taskService requires mdb at top-level.
 * Patch the mdb singleton before tests.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import __taskService from '../mongoose/services/taskService.js';

let savedTasks = [];
let findResult = [];
let findOneResult = null;

function makeTaskDoc(data) {
  return {
    ...data,
    toObject() { return { ...data }; },
    save: mock.fn(async function () { savedTasks.push(data); }),
  };
}

function patchMdb() {
  savedTasks = [];
  findResult = [];
  findOneResult = null;

  const TaskModel = function (data) {
    return makeTaskDoc(data);
  };
  TaskModel.find = mock.fn(() => ({
    sort: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(findResult)) })),
    select: mock.fn(() => ({
      limit: mock.fn(() => ({ lean: mock.fn(() => Promise.resolve(findResult)) })),
    })),
    lean: mock.fn(() => Promise.resolve(findResult)),
  }));
  TaskModel.findOne = mock.fn(() => ({
    select: mock.fn(() => ({
      lean: mock.fn(() => Promise.resolve(findOneResult)),
    })),
  }));
  TaskModel.findOneAndUpdate = mock.fn(() => {
    if (!findOneResult) return Promise.resolve(null);
    return Promise.resolve({ toObject() { return findOneResult; } });
  });
  TaskModel.countDocuments = mock.fn(() => Promise.resolve(0));

  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    task: TaskModel,
  };
}

const {
  createTask,
  completeTask,
  getPendingTasksForUser,
  getTaskCountsForUser,
  processRecurringTasks,
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

    it('returns same date for unknown recurrence', () => {
      const d = new Date('2025-06-01');
      assert.equal(advanceDate(d, 'none').getTime(), d.getTime());
    });

    it('uses current date when null', () => {
      const before = Date.now();
      assert.ok(advanceDate(null, 'daily').getTime() >= before);
    });
  });

  describe('createTask', () => {
    it('creates with valid input', async () => {
      const result = await createTask({ title: 'Fix bug', description: 'desc', userId: 'u1' });
      assert.equal(result.title, 'Fix bug');
      assert.equal(savedTasks.length, 1);
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

    it('returns completed task', async () => {
      findOneResult = { uuid: 'uuid1', completed: true, title: 'Done' };
      const result = await completeTask('uuid1', 'u1');
      assert.deepStrictEqual(result, { uuid: 'uuid1', completed: true, title: 'Done' });
    });
  });

  describe('getPendingTasksForUser', () => {
    it('returns empty for null userId', async () => {
      assert.deepStrictEqual(await getPendingTasksForUser(null), []);
    });

    it('returns tasks from DB', async () => {
      findResult = [{ title: 'A' }, { title: 'B' }];
      const result = await getPendingTasksForUser('u1');
      assert.equal(result.length, 2);
    });
  });

  describe('getTaskCountsForUser', () => {
    it('returns zeros for null userId', async () => {
      assert.deepStrictEqual(await getTaskCountsForUser(null), { total: 0, overdue: 0 });
    });

    it('returns counts from DB', async () => {
      mdb.INTERNAL.task.countDocuments = mock.fn(() => Promise.resolve(5));
      const result = await getTaskCountsForUser('u1');
      assert.equal(result.total, 5);
    });
  });

  describe('processRecurringTasks', () => {
    it('handles no recurring tasks', async () => {
      await processRecurringTasks();
    });

    it('spawns next recurring task', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 1);
      findResult = [{
        _id: 't1', title: 'Daily thing', description: 'desc',
        userId: 'u1', jobId: null, recurrence: 'daily', dueDate: past,
      }];
      // findOneResult is already null from beforeEach (no existing future task)

      await processRecurringTasks();
      assert.equal(savedTasks.length, 1);
      assert.equal(savedTasks[0].title, 'Daily thing');
    });
  });
});
