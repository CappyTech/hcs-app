import mdb from './mongooseDatabaseService.js';
import taskService from './taskService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';

const DEFAULT_DAYS_AHEAD = 90; // give enough lead time to arrange MOT/insurance/tax renewals
const KEY_PREFIX = 'vehicle:';

/**
 * Fields to check and their human-readable labels.
 */
const COMPLIANCE_FIELDS = [
  { field: 'motExpiryDate',       label: 'MOT' },
  { field: 'insuranceExpiryDate', label: 'Insurance' },
  { field: 'roadTaxExpiryDate',   label: 'Road Tax' },
];

/**
 * Scan all non-disposed vehicles for compliance dates that are:
 *  • Already expired (past due)
 *  • Expiring within `daysAhead` days
 *
 * Each (vehicle, field, date) is one reminder, identified by its systemKey and
 * given to every admin (taskService.ensureSystemTask): completing any copy
 * completes them all and the reminder isn't re-created; EXPIRING turns into
 * EXPIRED on the same task. After a clean scan, open reminders that no longer
 * apply (date renewed, vehicle disposed or deleted) are closed automatically.
 *
 * @param {Object} [opts]
 * @param {number} [opts.daysAhead=90]
 * @returns {Promise<{ created: number, skipped: number, errors: number, resolved?: number }>}
 */
async function checkComplianceAndCreateTasks({ daysAhead = DEFAULT_DAYS_AHEAD } = {}) {
  const stats = { created: 0, skipped: 0, errors: 0 };
  const newAlerts = []; // newly flagged items for the email summary

  const Vehicle = mdb.INTERNAL?.vehicle;
  const User = mdb.INTERNAL?.user;
  if (!Vehicle || !User) {
    logger.warn('[vehicleComplianceService] Vehicle or User model not available — skipping.');
    return stats;
  }

  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + daysAhead);

  // Find admin users to assign tasks to
  const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
  if (!adminUsers.length) {
    logger.warn('[vehicleComplianceService] No admin users found — cannot create tasks.');
    return stats;
  }
  const userIds = adminUsers.map((u) => u._id);
  const currentKeys = new Set();

  for (const { field, label } of COMPLIANCE_FIELDS) {
    // Vehicles where this date is within the horizon (including already expired)
    const vehicles = await Vehicle.find({
      [field]: { $lte: horizon },
      availabilityStatus: { $ne: 'Disposed' }
    }).lean();

    for (const vehicle of vehicles) {
      const expiryDate = vehicle[field];
      if (!expiryDate) continue;

      const isExpired = expiryDate < now;
      const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
      const dateStr = new Date(expiryDate).toISOString().slice(0, 10);
      const systemKey = `${KEY_PREFIX}${vehicle._id}:${field}:${dateStr}`;
      currentKeys.add(systemKey);

      const suffix = isExpired
        ? `expired ${Math.abs(daysLeft)} day(s) ago`
        : `expires in ${daysLeft} day(s)`;
      const subject = `${label} – ${vehicle.registrationNumber} (${vehicle.make} ${vehicle.model})`;
      const title = `[${isExpired ? 'EXPIRED' : 'EXPIRING'}] ${subject}`;
      // No day count here: the task is kept for weeks and would go stale.
      const description = `Vehicle ${vehicle.registrationNumber} ${label} ${isExpired ? 'expired' : 'expires'} on ${dateStr}. Renew it and update the vehicle record; this task closes itself once the date is updated.`;

      try {
        const r = await taskService.ensureSystemTask({
          systemKey,
          title,
          legacyTitles: [`[EXPIRED] ${subject}`, `[EXPIRING] ${subject}`],
          description,
          dueDate: expiryDate,
          priority: isExpired ? 'high' : 'normal',
          userIds,
        });
        stats.created += r.created;
        stats.skipped += r.skipped;
        if (r.created > 0 || r.updated > 0) {
          newAlerts.push(`${vehicle.registrationNumber} (${vehicle.make} ${vehicle.model}) — ${label} ${suffix}`);
        }
      } catch (err) {
        logger.error(`[vehicleComplianceService] Failed to create task for ${vehicle.registrationNumber} / ${label}: ${err.message}`);
        stats.errors++;
      }
    }
  }

  // Only a complete scan can say a reminder no longer applies.
  if (stats.errors === 0) {
    try {
      stats.resolved = await taskService.resolveStaleSystemTasks(KEY_PREFIX, currentKeys);
    } catch (err) {
      logger.error(`[vehicleComplianceService] Failed to close resolved tasks: ${err.message}`);
    }
  }

  // Email a daily summary of newly flagged items (deduped: max one per day)
  if (newAlerts.length > 0) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      await notificationService.enqueueForRoles(['admin'], {
        subject: `Fleet compliance: ${newAlerts.length} item(s) need attention`,
        html: notificationService.wrapTemplate({
          heading: 'Fleet Compliance Alerts',
          bodyLines: [
            'The following vehicle compliance items are expired or expiring soon:',
            ...newAlerts,
          ],
          ctaText: 'Open Fleet Management',
          ctaUrl: `${notificationService.baseUrl()}/fleet`,
        }),
        text: ['Vehicle compliance items needing attention:', ...newAlerts].join('\n'),
        category: 'fleet',
        dedupeKey: `fleet-compliance-${today}`,
      });
    } catch (err) {
      logger.error(`[vehicleComplianceService] Failed to queue alert email: ${err.message}`);
    }
  }

  if (stats.created > 0 || stats.errors > 0 || stats.resolved > 0) {
    logger.info(`[vehicleComplianceService] Compliance check complete: ${stats.created} tasks created, ${stats.skipped} skipped, ${stats.resolved || 0} closed, ${stats.errors} errors.`);
  }

  return stats;
}

export default {
  checkComplianceAndCreateTasks,
};

export { checkComplianceAndCreateTasks };
