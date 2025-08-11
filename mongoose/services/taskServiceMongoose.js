const mdb = require('./mongooseDatabaseService');

async function createTask({ title, description, userId, jobId = null, dueDate = null, recurrence = 'none' }) {
  const task = new mdb.INTERNAL.task({ title, description, userId, jobId, dueDate, recurrence });
  await task.save();
  return task;
}

function advanceDate(date, recurrence) {
  const next = new Date(date);
  if (recurrence === 'daily') next.setDate(next.getDate() + 1);
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
  else if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
  return next;
}

async function getPendingTasksForUser(userId) {
  if (!userId) return [];
  const tasks = await mdb.INTERNAL.task.find({ userId, completed: false }).sort({ dueDate: 1 });
  return tasks.map(t => t.toObject());
}

async function processRecurringTasks() {
  const now = new Date();
  const recurringTasks = await mdb.INTERNAL.task.find({
    recurrence: { $ne: 'none' },
    dueDate: { $lt: now },
    completed: false
  });

  for (const task of recurringTasks) {
    const nextDate = advanceDate(task.dueDate, task.recurrence);

    // Check if a future task already exists
  const existing = await mdb.INTERNAL.task.findOne({
      userId: task.userId,
      title: task.title,
      dueDate: { $gte: nextDate },
    });

    if (!existing) {
      await createTask({
        title: task.title,
        description: task.description,
        userId: task.userId,
        jobId: task.jobId,
        dueDate: nextDate,
        recurrence: task.recurrence
      });
    }
  }
}


module.exports = {
  createTask,
  getPendingTasksForUser,
  processRecurringTasks,
};
