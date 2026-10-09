import { format } from 'date-fns';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';

/**
 * Task due reminders ('task-due' email type).
 *
 * Once a day, each user with open tasks that are overdue or due in the next
 * 24 hours gets one digest email listing them. Goes through the notification
 * outbox, so it respects the user's "Task reminders" subscription; the dedupe
 * key (user + date) means at most one digest per user per day however often
 * the job runs.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LISTED = 20;

function lineFor(task, now) {
  const due = new Date(task.dueDate);
  const when = due.toLocaleDateString('en-GB');
  const flag = task.priority === 'high' ? ' (high priority)' : '';
  return due < now ? `Overdue since ${when}: ${task.title}${flag}` : `Due ${when}: ${task.title}${flag}`;
}

async function queueDueReminders(now = new Date()) {
  const stats = { users: 0, tasks: 0 };
  const Task = mdb.INTERNAL?.task;
  const User = mdb.INTERNAL?.user;
  if (!Task || !User) {
    logger.warn('[taskReminderService] Task or User model not available — skipping.');
    return stats;
  }

  const tasks = await Task.find({
    completed: false,
    dueDate: { $ne: null, $lte: new Date(now.getTime() + WINDOW_MS) },
  })
    .select('uuid title dueDate priority userId')
    .sort({ dueDate: 1 })
    .lean();
  if (!tasks.length) return stats;

  const byUser = new Map();
  for (const t of tasks) {
    const key = String(t.userId);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(t);
  }

  const users = await User.find({ _id: { $in: [...byUser.keys()] } })
    .select('email emailVerified')
    .lean();
  const today = format(now, 'yyyy-MM-dd');
  const baseUrl = notificationService.baseUrl();

  for (const user of users) {
    if (!user.email || !user.emailVerified) continue;
    const list = byUser.get(String(user._id)) || [];
    if (!list.length) continue;

    const overdue = list.filter((t) => new Date(t.dueDate) < now).length;
    const lines = list.slice(0, MAX_LISTED).map((t) => lineFor(t, now));
    if (list.length > MAX_LISTED) lines.push(`…and ${list.length - MAX_LISTED} more.`);
    const subject = overdue
      ? `${list.length} task(s) need attention (${overdue} overdue)`
      : `${list.length} task(s) due in the next 24 hours`;

    try {
      await notificationService.enqueue({
        to: user.email,
        subject,
        html: notificationService.wrapTemplate({
          heading: 'Task reminders',
          bodyLines: lines,
          ctaText: 'View your tasks',
          ctaUrl: `${baseUrl}/`,
        }),
        text: ['Task reminders:', ...lines].join('\n'),
        typeKey: 'task-due',
        senderType: 'system',
        recipientUserId: user._id,
        refType: 'task',
        dedupeKey: `task-due:${user._id}:${today}`,
      });
      stats.users++;
      stats.tasks += list.length;
    } catch (err) {
      logger.warn(`[taskReminderService] Reminder for user ${user._id} skipped: ${err.message}`);
    }
  }
  return stats;
}

export default { queueDueReminders };
export { queueDueReminders };
