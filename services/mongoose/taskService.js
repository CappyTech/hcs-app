const mdb = require('./mongooseDatabaseService');

async function createTask({ title, description, userId, jobId = null, dueDate = null, recurrence = 'none' }) {
  const task = new mdb.task({ title, description, userId, jobId, dueDate, recurrence });
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
  const tasks = await mdb.task.find({ userId, completed: false }).sort({ dueDate: 1 });
  const now = new Date();

  for (const task of tasks) {
    if (task.recurrence !== 'none' && task.dueDate && task.dueDate < now) {
      let next = new Date(task.dueDate);
      while (next < now) {
        next = advanceDate(next, task.recurrence);
      }
      task.dueDate = next;
      await task.save();
    }
  }

  return tasks.map(t => t.toObject());
}

module.exports = {
  createTask,
  getPendingTasksForUser,
};
