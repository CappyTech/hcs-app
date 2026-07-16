const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');
const notificationService = require('../../services/notificationService');

// Fire-and-forget: email the assignee that a task was created for them. Routed
// through the notification outbox as a 'task-assigned' system notification, so
// it honours the user's subscription and never blocks/fails task creation.
async function notifyTaskAssigned(task) {
  try {
    if (!task || !task.userId) return;
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

async function createTask({ title, description, userId, jobId = null, dueDate = null, recurrence = 'none' }) {
  validateCreateInput({ title, userId, recurrence, dueDate });
  const task = new mdb.INTERNAL.task({ title, description, userId, jobId, dueDate, recurrence });
  await task.save();
  const obj = task.toObject();
  await notifyTaskAssigned(obj);
  return obj;
}

function advanceDate(date, recurrence) {
  const base = date ? new Date(date) : new Date();
  const next = new Date(base);
  switch (recurrence) {
    case 'daily':
      next.setDate(next.getDate() + 1); break;
    case 'weekly':
      next.setDate(next.getDate() + 7); break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1); break;
    default:
      return base;
  }
  return next;
}

async function getPendingTasksForUser(userId) {
  if (!userId) return [];
  // Using lean for performance since we only read data
  const tasks = await mdb.INTERNAL.task.find({ userId, completed: false })
    .sort({ dueDate: 1 })
    .lean();
  return tasks;
}

// Ensures recurring tasks spawn their next instance once they are past due
// and not already duplicated. Idempotent if run multiple times close together.
async function processRecurringTasks({ limit = 200 } = {}) {
  const now = new Date();
  // Fetch only necessary fields and limit batch size to avoid long locks
  const recurringTasks = await mdb.INTERNAL.task.find({
    recurrence: { $ne: 'none' },
    dueDate: { $lte: now },
    completed: false
  })
    .select('title description userId jobId recurrence dueDate')
    .limit(limit)
    .lean();

  for (const task of recurringTasks) {
    if (!task.dueDate) continue; // Defensive
    const nextDate = advanceDate(task.dueDate, task.recurrence);
    if (!nextDate || nextDate <= task.dueDate) continue; // Safety guard

    // Idempotency guard: only create a future one if not already present
    const existing = await mdb.INTERNAL.task.findOne({
      userId: task.userId,
      title: task.title,
      dueDate: { $gte: nextDate },
      recurrence: task.recurrence
    }).select('_id').lean();

    if (!existing) {
      await createTask({
        title: task.title,
        description: task.description,
        userId: task.userId,
        jobId: task.jobId,
        dueDate: nextDate,
        recurrence: task.recurrence
      });
      logger.debug(`[taskService] Spawned next recurring task`, { title: task.title, nextDate, userId: task.userId });
    }
  }
}

async function completeTask(uuid, userId) {
  if (!uuid || !userId) throw new Error('uuid and userId are required.');
  const task = await mdb.INTERNAL.task.findOneAndUpdate(
    { uuid, userId, completed: false },
    { completed: true },
    { new: true },
  );
  return task ? task.toObject() : null;
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

module.exports = {
  createTask,
  completeTask,
  getPendingTasksForUser,
  getTaskCountsForUser,
  processRecurringTasks,
  advanceDate // exported for potential testing
};
