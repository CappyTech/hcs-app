import { addDays, addWeeks, addMonths, startOfDay } from 'date-fns';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';

// Fire-and-forget: email the assignee that a task was created for them. Routed
// through the notification outbox as a 'task-assigned' system notification, so
// it honours the user's subscription and never blocks/fails task creation.
// Skipped when someone assigns a task to themselves (quick add) — they know.
async function notifyTaskAssigned(task, { assignedBy = null } = {}) {
  try {
    if (!task || !task.userId) return;
    if (assignedBy && String(assignedBy) === String(task.userId)) return;
    const user = await mdb.INTERNAL.user
      .findById(task.userId)
      .select('email emailVerified')
      .lean();
    if (!user || !user.email || !user.emailVerified) return;

    const baseUrl = notificationService.baseUrl();
    const dueLine = task.dueDate
      ? `Due: ${new Date(task.dueDate).toLocaleDateString('en-GB')}`
      : 'No due date set.';
    await notificationService.enqueue({
      to: user.email,
      subject: `New task: ${task.title}`,
      html: notificationService.wrapTemplate({
        heading: 'A task has been assigned to you',
        bodyLines: [task.title, task.description || '', dueLine].filter(Boolean),
        ctaText: 'View your tasks',
        ctaUrl: `${baseUrl}/`,
      }),
      text: [`A task has been assigned to you: ${task.title}`, task.description, dueLine]
        .filter(Boolean).join('\n\n'),
      typeKey: 'task-assigned',
      senderType: 'system',
      recipientUserId: task.userId,
      refType: 'task',
      refId: task.uuid || task._id,
      dedupeKey: `task-assigned:${task.uuid || task._id}`,
    });
  } catch (err) {
    logger.warn(`[taskService] task-assigned email skipped: ${err.message}`);
  }
}

function validateCreateInput({ title, userId, recurrence, dueDate }) {
  if (!title || typeof title !== 'string') throw new Error('Task title is required.');
  if (!userId) throw new Error('userId is required for task creation.');
  if (recurrence && recurrence !== 'none' && !dueDate) {
    throw new Error('Recurring tasks must include dueDate.');
  }
}

// notify=false for tasks whose owner hears about them another way (system
// reminders send their own summary email; recurring occurrences continue a
// series the owner already has). assignedBy suppresses self-assignment emails.
async function createTask({ title, description, userId, contractId = null, dueDate = null, recurrence = 'none', priority = 'normal', source = 'manual', systemKey = null, notify = true, assignedBy = null }) {
  validateCreateInput({ title, userId, recurrence, dueDate });
  const task = new mdb.INTERNAL.task({ title, description, userId, contractId, dueDate, recurrence, priority, source, systemKey });
  await task.save();
  const obj = task.toObject();
  if (notify) await notifyTaskAssigned(obj, { assignedBy });
  return obj;
}

const STEP = { daily: addDays, weekly: addWeeks, monthly: addMonths };

// The date `steps` periods after `date`. Each step is computed from the
// original date (not chained), so a monthly task on the 31st lands on the last
// day of shorter months and returns to the 31st afterwards.
function advanceDate(date, recurrence, steps = 1) {
  const base = date ? new Date(date) : new Date();
  const step = STEP[recurrence];
  return step ? step(base, steps) : base;
}

// Due date of the occurrence after `task`: one period on from its due date,
// skipping periods that have already gone by (a weekly task finished three
// weeks late isn't followed by two instantly-overdue copies). Today counts as
// not yet gone, so a daily task finished a day late is due again today.
function nextOccurrenceDate(task, now = new Date()) {
  if (!task.dueDate || !STEP[task.recurrence]) return null;
  const floor = startOfDay(now);
  let steps = 1;
  let next = advanceDate(task.dueDate, task.recurrence, steps);
  while (next < floor && steps < 10_000) {
    steps += 1;
    next = advanceDate(task.dueDate, task.recurrence, steps);
  }
  return next;
}

// Create the next occurrence of a completed recurring task, exactly once. The
// task is claimed by setting nextSpawnedAt atomically, so the completion
// handler and the recurring-tasks job can both call this safely.
async function spawnNextOccurrence(task) {
  const Task = mdb.INTERNAL.task;
  const nextDate = nextOccurrenceDate(task);
  if (!nextDate) return null;

  const claimed = await Task.findOneAndUpdate(
    { _id: task._id, nextSpawnedAt: null },
    { $set: { nextSpawnedAt: new Date() } },
  );
  if (!claimed) return null; // already spawned

  try {
    const next = await createTask({
      title: task.title,
      description: task.description,
      userId: task.userId,
      contractId: task.contractId,
      dueDate: nextDate,
      recurrence: task.recurrence,
      priority: task.priority,
      source: task.source,
      notify: false,
    });
    logger.debug('[taskService] Spawned next recurring task', { title: task.title, nextDate, userId: task.userId });
    return next;
  } catch (err) {
    // Release the claim so the recurring-tasks job retries it.
    await Task.updateOne({ _id: task._id }, { $set: { nextSpawnedAt: null } });
    throw err;
  }
}

async function getPendingTasksForUser(userId) {
  if (!userId) return [];
  // Using lean for performance since we only read data
  const tasks = await mdb.INTERNAL.task.find({ userId, completed: false })
    .sort({ dueDate: 1 })
    .lean();
  return tasks;
}

// Safety net for the completion handler: any completed recurring task whose
// next occurrence wasn't created (the spawn failed or the process stopped
// mid-way) gets it now. Only tasks completed since completedAt existed are
// considered, so recurring tasks ticked off before this was fixed stay ended.
async function processRecurringTasks({ limit = 200 } = {}) {
  const stats = { spawned: 0, errors: 0 };
  const pending = await mdb.INTERNAL.task.find({
    recurrence: { $ne: 'none' },
    completed: true,
    completedAt: { $ne: null },
    nextSpawnedAt: null,
  })
    .select('title description userId contractId recurrence dueDate priority source')
    .limit(limit)
    .lean();

  for (const task of pending) {
    try {
      if (await spawnNextOccurrence(task)) stats.spawned++;
    } catch (err) {
      stats.errors++;
      logger.error(`[taskService] Failed to spawn next occurrence of "${task.title}": ${err.message}`);
    }
  }
  return stats;
}

async function completeTask(uuid, userId) {
  if (!uuid || !userId) throw new Error('uuid and userId are required.');
  const Task = mdb.INTERNAL.task;
  const completedAt = new Date();
  const task = await Task.findOneAndUpdate(
    { uuid, userId, completed: false },
    { completed: true, completedAt, completedBy: userId },
    { new: true },
  );
  if (!task) return null;
  const obj = task.toObject();

  // A system reminder goes to every admin; one of them dealing with it closes
  // everyone's copy.
  if (obj.systemKey) {
    await Task.updateMany(
      { systemKey: obj.systemKey, completed: false },
      { $set: { completed: true, completedAt, completedBy: userId } },
    );
  }

  if (obj.recurrence && obj.recurrence !== 'none') {
    try {
      await spawnNextOccurrence(obj);
    } catch (err) {
      // The task is completed; the recurring-tasks job will create the next one.
      logger.error(`[taskService] Next occurrence of "${obj.title}" not created yet: ${err.message}`);
    }
  }
  return obj;
}

/**
 * Make sure every user in `userIds` has the system reminder identified by
 * `systemKey`, unless someone has already completed it.
 *
 *  • Tasks created before systemKey existed (same title, open, no key) are
 *    adopted into the key instead of being duplicated.
 *  • If any copy is completed, the reminder counts as handled: nothing is
 *    created, for anyone — completing it is how an admin says "dealt with".
 *  • Open copies whose title has changed (EXPIRING → EXPIRED) are reworded
 *    and get the new priority, rather than a second task appearing.
 */
async function ensureSystemTask({ systemKey, title, legacyTitles = [], description, dueDate = null, priority = 'normal', userIds = [] }) {
  if (!systemKey) throw new Error('systemKey is required.');
  const Task = mdb.INTERNAL.task;
  const stats = { created: 0, updated: 0, skipped: 0, adopted: 0, handled: false };

  if (legacyTitles.length) {
    const res = await Task.updateMany(
      { source: 'system', systemKey: null, completed: false, title: { $in: legacyTitles } },
      { $set: { systemKey } },
    );
    stats.adopted = res?.modifiedCount || 0;
  }

  const done = await Task.findOne({ systemKey, completed: true }).select('_id').lean();
  if (done) {
    stats.handled = true;
    stats.skipped = userIds.length;
    return stats;
  }

  const open = await Task.find({ systemKey, completed: false }).select('userId title').lean();
  const reworded = open.filter((t) => t.title !== title);
  if (reworded.length) {
    await Task.updateMany(
      { systemKey, completed: false, title: { $ne: title } },
      { $set: { title, description, priority, dueDate } },
    );
    stats.updated = reworded.length;
  }

  const have = new Set(open.map((t) => String(t.userId)));
  for (const userId of userIds) {
    if (have.has(String(userId))) { stats.skipped++; continue; }
    await createTask({ title, description, userId, dueDate, priority, source: 'system', systemKey, notify: false });
    have.add(String(userId));
    stats.created++;
  }
  return stats;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Close open system tasks under `prefix` (e.g. 'vehicle:') whose key wasn't
 * produced by the latest full scan — the date was renewed, the record was
 * disposed/deactivated or deleted, so the reminder no longer applies.
 * Callers must only use this after a scan that finished without errors.
 */
async function resolveStaleSystemTasks(prefix, currentKeys) {
  const res = await mdb.INTERNAL.task.updateMany(
    {
      source: 'system',
      completed: false,
      systemKey: { $regex: `^${escapeRegex(prefix)}`, $nin: [...currentKeys] },
    },
    { $set: { completed: true, completedAt: new Date(), completedBy: null, autoResolved: true } },
  );
  return res?.modifiedCount || 0;
}

async function getTaskCountsForUser(userId) {
  if (!userId) return { total: 0, overdue: 0 };
  const now = new Date();
  const [total, overdue] = await Promise.all([
    mdb.INTERNAL.task.countDocuments({ userId, completed: false }),
    mdb.INTERNAL.task.countDocuments({ userId, completed: false, dueDate: { $lt: now } }),
  ]);
  return { total, overdue };
}

export default {
  createTask,
  completeTask,
  getPendingTasksForUser,
  getTaskCountsForUser,
  processRecurringTasks,
  spawnNextOccurrence,
  nextOccurrenceDate,
  notifyTaskAssigned,
  ensureSystemTask,
  resolveStaleSystemTasks,
  advanceDate // exported for potential testing
};

export {
  createTask, completeTask, getPendingTasksForUser, getTaskCountsForUser, processRecurringTasks,
  spawnNextOccurrence, nextOccurrenceDate, notifyTaskAssigned, ensureSystemTask, resolveStaleSystemTasks, advanceDate,
};
