import mdb from './mongooseDatabaseService.js';
import taskService from './taskService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';

const DEFAULT_DAYS_AHEAD = 30;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

let intervalHandle = null;

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
 * For each match, create a task for every admin user — but only if no
 * matching uncompleted task already exists (idempotent).
 *
 * @param {Object} [opts]
 * @param {number} [opts.daysAhead=30]
 * @returns {Promise<{ created: number, skipped: number, errors: number }>}
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

      const prefix = isExpired ? 'EXPIRED' : 'EXPIRING';
      const suffix = isExpired
        ? `expired ${Math.abs(daysLeft)} day(s) ago`
        : `expires in ${daysLeft} day(s)`;

      const title = `[${prefix}] ${label} – ${vehicle.registrationNumber} (${vehicle.make} ${vehicle.model})`;
      const description = `Vehicle ${vehicle.registrationNumber} ${label} ${suffix} on ${expiryDate.toISOString().slice(0, 10)}. Please renew or update the record.`;

      let createdForVehicle = false;
      for (const admin of adminUsers) {
        try {
          // Idempotency: check if an uncompleted task with same title already exists
          const existing = await mdb.INTERNAL.task.findOne({
            userId: admin._id,
            title,
            completed: false
          }).select('_id').lean();

          if (existing) {
            stats.skipped++;
            continue;
          }

          await taskService.createTask({
            title,
            description,
            userId: admin._id,
            dueDate: expiryDate
          });
          stats.created++;
          createdForVehicle = true;
        } catch (err) {
          logger.error(`[vehicleComplianceService] Failed to create task for ${vehicle.registrationNumber} / ${label}: ${err.message}`);
          stats.errors++;
        }
      }

      if (createdForVehicle) {
        newAlerts.push(`${vehicle.registrationNumber} (${vehicle.make} ${vehicle.model}) — ${label} ${suffix}`);
      }
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

  if (stats.created > 0 || stats.errors > 0) {
    logger.info(`[vehicleComplianceService] Compliance check complete: ${stats.created} tasks created, ${stats.skipped} skipped, ${stats.errors} errors.`);
  }

  return stats;
}

/**
 * Start the periodic compliance check (runs once immediately, then every 24 h).
 */
function start() {
  if (intervalHandle) return; // already running

  logger.info('[vehicleComplianceService] Starting periodic compliance check (every 24 h).');

  // Run after a short delay on startup to allow DB models to settle
  setTimeout(async () => {
    try {
      await checkComplianceAndCreateTasks();
    } catch (err) {
      logger.error(`[vehicleComplianceService] Initial compliance check failed: ${err.message}`, { stack: err.stack });
    }
  }, 10_000);

  intervalHandle = setInterval(async () => {
    try {
      await checkComplianceAndCreateTasks();
    } catch (err) {
      logger.error(`[vehicleComplianceService] Periodic compliance check failed: ${err.message}`, { stack: err.stack });
    }
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic compliance check.
 */
function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('[vehicleComplianceService] Stopped periodic compliance check.');
  }
}

export default {
  checkComplianceAndCreateTasks,
  start,
  stop,
};

export { checkComplianceAndCreateTasks, start, stop };
