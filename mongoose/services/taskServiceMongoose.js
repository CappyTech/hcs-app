const mdb = require('./mongooseDatabaseService');

// Lightweight logger placeholder (replace with central logger if available)
function logDebug(msg, meta = {}) {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug(`[taskService] ${msg}`, meta);
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
  return task.toObject();
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
      logDebug('Spawned next recurring task', { title: task.title, nextDate, userId: task.userId });
    }
  }
}

module.exports = {
  createTask,
  getPendingTasksForUser,
  processRecurringTasks,
  advanceDate // exported for potential testing
};
