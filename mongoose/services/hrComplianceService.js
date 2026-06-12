'use strict';

const mdb = require('./mongooseDatabaseService');
const taskService = require('./taskService');
const logger = require('../../services/loggerService');

const DEFAULT_DAYS_AHEAD = 30;

/**
 * HR compliance reminders — mirrors vehicleComplianceService.
 *
 * Scans active employees for HR dates that are expired or expiring within
 * `daysAhead` days:
 *  • contract.endDate    (fixed-term / temporary contracts running out)
 *  • rightToWork.expiryDate (visa / share-code re-checks)
 *
 * For each match, create a task for every admin user (idempotent — skipped
 * while an uncompleted task with the same title exists) and queue one daily
 * summary email to admins via the notification outbox.
 */

function itemsForEmployee(employee) {
  const items = [];
  if (employee.contract?.endDate) {
    items.push({ label: 'Contract end', date: employee.contract.endDate });
  }
  if (employee.rightToWork?.expiryDate) {
    items.push({ label: 'Right to work', date: employee.rightToWork.expiryDate });
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

  const employees = await Employee.find({
    status: 'active',
    $or: [
      { 'contract.endDate': { $ne: null, $lte: horizon } },
      { 'rightToWork.expiryDate': { $ne: null, $lte: horizon } },
    ],
  }).lean();

  for (const employee of employees) {
    for (const { label, date } of itemsForEmployee(employee)) {
      if (!date || date > horizon) continue;

      const isExpired = date < now;
      const daysLeft = Math.ceil((date - now) / (1000 * 60 * 60 * 24));
      const prefix = isExpired ? 'EXPIRED' : 'EXPIRING';
      const suffix = isExpired
        ? `expired ${Math.abs(daysLeft)} day(s) ago`
        : `expires in ${daysLeft} day(s)`;

      const title = `[${prefix}] ${label} – ${employee.name}`;
      const description = `${employee.name}: ${label} ${suffix} on ${new Date(date).toISOString().slice(0, 10)}. Please review and update the employee record.`;

      let createdForEmployee = false;
      for (const admin of adminUsers) {
        try {
          const existing = await mdb.INTERNAL.task.findOne({
            userId: admin._id,
            title,
            completed: false,
          }).select('_id').lean();

          if (existing) {
            stats.skipped++;
            continue;
          }

          await taskService.createTask({
            title,
            description,
            userId: admin._id,
            dueDate: date,
          });
          stats.created++;
          createdForEmployee = true;
        } catch (err) {
          logger.error(`[hrComplianceService] Failed to create task for ${employee.name} / ${label}: ${err.message}`);
          stats.errors++;
        }
      }

      if (createdForEmployee) {
        newAlerts.push(`${employee.name} — ${label} ${suffix}`);
      }
    }
  }

  // Email a daily summary of newly flagged items (deduped: max one per day)
  if (newAlerts.length > 0) {
    try {
      const notificationService = require('../../services/notificationService');
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

  if (stats.created > 0 || stats.errors > 0) {
    logger.info(`[hrComplianceService] Compliance check complete: ${stats.created} tasks created, ${stats.skipped} skipped, ${stats.errors} errors.`);
  }

  return stats;
}

module.exports = {
  checkExpiriesAndCreateTasks,
};
