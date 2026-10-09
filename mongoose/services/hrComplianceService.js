import mdb from './mongooseDatabaseService.js';
import taskService from './taskService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';

const DEFAULT_DAYS_AHEAD = 90; // give enough lead time to arrange contract/right-to-work renewals
const KEY_PREFIX = 'employee:';

/**
 * HR compliance reminders — mirrors vehicleComplianceService.
 *
 * Scans active employees for HR dates that are expired or expiring within
 * `daysAhead` days:
 *  • contract.endDate    (fixed-term / temporary contracts running out)
 *  • rightToWork.expiryDate (visa / share-code re-checks)
 *
 * Each (employee, field, date) is one reminder, identified by its systemKey and
 * given to every admin (taskService.ensureSystemTask): completing any copy
 * completes them all and the reminder isn't re-created; EXPIRING turns into
 * EXPIRED on the same task. After a clean scan, open reminders that no longer
 * apply (date updated, employee no longer active or deleted) are closed
 * automatically. Newly flagged items go out in one daily summary email.
 */

function itemsForEmployee(employee) {
  const items = [];
  if (employee.contract?.endDate) {
    items.push({ field: 'contract.endDate', label: 'Contract end', date: employee.contract.endDate });
  }
  if (employee.rightToWork?.expiryDate) {
    items.push({ field: 'rightToWork.expiryDate', label: 'Right to work', date: employee.rightToWork.expiryDate });
  }
  return items;
}

async function checkExpiriesAndCreateTasks({ daysAhead = DEFAULT_DAYS_AHEAD } = {}) {
  const stats = { created: 0, skipped: 0, errors: 0 };
  const newAlerts = [];

  const Employee = mdb.INTERNAL?.employee;
  const User = mdb.INTERNAL?.user;
  if (!Employee || !User) {
    logger.warn('[hrComplianceService] Employee or User model not available — skipping.');
    return stats;
  }

  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + daysAhead);

  const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
  if (!adminUsers.length) {
    logger.warn('[hrComplianceService] No admin users found — cannot create tasks.');
    return stats;
  }

  const userIds = adminUsers.map((u) => u._id);
  const currentKeys = new Set();

  const employees = await Employee.find({
    status: 'active',
    $or: [
      { 'contract.endDate': { $ne: null, $lte: horizon } },
      { 'rightToWork.expiryDate': { $ne: null, $lte: horizon } },
    ],
  }).lean();

  for (const employee of employees) {
    for (const { field, label, date } of itemsForEmployee(employee)) {
      if (!date || date > horizon) continue;

      const isExpired = date < now;
      const daysLeft = Math.ceil((date - now) / (1000 * 60 * 60 * 24));
      const dateStr = new Date(date).toISOString().slice(0, 10);
      const systemKey = `${KEY_PREFIX}${employee._id}:${field}:${dateStr}`;
      currentKeys.add(systemKey);

      const suffix = isExpired
        ? `expired ${Math.abs(daysLeft)} day(s) ago`
        : `expires in ${daysLeft} day(s)`;
      const subject = `${label} – ${employee.name}`;
      const title = `[${isExpired ? 'EXPIRED' : 'EXPIRING'}] ${subject}`;
      // No day count here: the task is kept for weeks and would go stale.
      const description = `${employee.name}: ${label} ${isExpired ? 'expired' : 'expires'} on ${dateStr}. Review and update the employee record; this task closes itself once the date is updated.`;

      try {
        const r = await taskService.ensureSystemTask({
          systemKey,
          title,
          legacyTitles: [`[EXPIRED] ${subject}`, `[EXPIRING] ${subject}`],
          description,
          dueDate: date,
          priority: isExpired ? 'high' : 'normal',
          userIds,
        });
        stats.created += r.created;
        stats.skipped += r.skipped;
        if (r.created > 0 || r.updated > 0) {
          newAlerts.push(`${employee.name} — ${label} ${suffix}`);
        }
      } catch (err) {
        logger.error(`[hrComplianceService] Failed to create task for ${employee.name} / ${label}: ${err.message}`);
        stats.errors++;
      }
    }
  }

  // Only a complete scan can say a reminder no longer applies.
  if (stats.errors === 0) {
    try {
      stats.resolved = await taskService.resolveStaleSystemTasks(KEY_PREFIX, currentKeys);
    } catch (err) {
      logger.error(`[hrComplianceService] Failed to close resolved tasks: ${err.message}`);
    }
  }

  // Email a daily summary of newly flagged items (deduped: max one per day)
  if (newAlerts.length > 0) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      await notificationService.enqueueForRoles(['admin'], {
        subject: `HR compliance: ${newAlerts.length} item(s) need attention`,
        html: notificationService.wrapTemplate({
          heading: 'HR Compliance Alerts',
          bodyLines: [
            'The following employee compliance items are expired or expiring soon:',
            ...newAlerts,
          ],
          ctaText: 'Open Employees',
          ctaUrl: `${notificationService.baseUrl()}/employees`,
        }),
        text: ['Employee compliance items needing attention:', ...newAlerts].join('\n'),
        category: 'hr',
        dedupeKey: `hr-compliance-${today}`,
      });
    } catch (err) {
      logger.error(`[hrComplianceService] Failed to queue alert email: ${err.message}`);
    }
  }

  if (stats.created > 0 || stats.errors > 0 || stats.resolved > 0) {
    logger.info(`[hrComplianceService] Compliance check complete: ${stats.created} tasks created, ${stats.skipped} skipped, ${stats.resolved || 0} closed, ${stats.errors} errors.`);
  }

  return stats;
}

export default {
  checkExpiriesAndCreateTasks,
};

export { checkExpiriesAndCreateTasks };
