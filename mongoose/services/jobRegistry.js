'use strict';

const scheduler = require('./jobSchedulerService');

/**
 * Single place where all background jobs are registered.
 * Called once from app.js after MongoDB is ready. The admin jobs page
 * (/admin/jobs) reads scheduler.getStatus() and can trigger any job manually.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function registerAll() {
  scheduler.register('session-cleanup', {
    description: 'Remove expired login sessions from the session store.',
    intervalMs: 5 * MINUTE,
    initialDelayMs: 5_000,
    run: () => require('./sessionCleanupService').cleanupOnce(),
  });

  scheduler.register('notification-outbox', {
    description: 'Deliver queued email notifications with retry/backoff.',
    intervalMs: MINUTE,
    initialDelayMs: 15_000,
    run: () => require('../../services/notificationService').processOutbox(),
  });

  scheduler.register('vehicle-compliance', {
    description: 'Create tasks and email alerts for vehicles with MOT/insurance/road tax expiring within 30 days.',
    intervalMs: DAY,
    run: () => require('./vehicleComplianceService').checkComplianceAndCreateTasks(),
  });

  scheduler.register('ocr-orphans', {
    description: 'Clear KashFlow links on OCR documents whose purchase has been deleted (docs sent in the last 48 h are held). Manual only — run from this page or the Documents overview.',
    intervalMs: null, // manual-only: admin decides when stale links are cleared
    run: () => require('./ocrOrphanService').detectAndClearOrphans(),
  });

  scheduler.register('cis-return-reminder', {
    description: 'Email admin/accountant users 7 and 2 days before the CIS monthly return deadline (19th).',
    intervalMs: 12 * HOUR,
    run: () => require('./cisReturnReminderService').checkAndQueueReminders(),
  });

  scheduler.register('gdpr-deadlines', {
    description: 'Alert admins when GDPR requests approach or pass their 30-day statutory deadline.',
    intervalMs: 12 * HOUR,
    run: () => require('./gdprDeadlineService').checkDeadlines(),
  });

  scheduler.register('deleted-items-purge', {
    description: 'Permanently remove soft-deleted records past retention (requires DELETED_ITEMS_RETENTION_DAYS; off by default).',
    intervalMs: DAY,
    run: () => require('./deletedItemsPurgeService').purgeOnce(),
  });

  scheduler.register('bank-holiday-sync', {
    description: 'Sync UK bank holidays from the GOV.UK feed into the Government Holidays list.',
    intervalMs: 7 * DAY,
    run: () => require('./holidayService').syncBankHolidays(),
  });

  scheduler.register('hr-compliance', {
    description: 'Create tasks and email alerts for employee contracts and right-to-work checks expiring within 30 days.',
    intervalMs: DAY,
    run: () => require('./hrComplianceService').checkExpiriesAndCreateTasks(),
  });

  scheduler.register('policy-review-reminder', {
    description: 'Email admins when company policies reach their review date (30-day warning).',
    intervalMs: DAY,
    run: () => require('./policyReviewReminderService').checkAndQueueReminders(),
  });

  scheduler.register('unsubscribe-token-rotation', {
    description: "Rotate every user's unsubscribe token so email unsubscribe links expire ~daily. Runs on startup (if due) and every 24h; enable/disable and last-run are on the Email & Notifications admin page.",
    intervalMs: DAY,
    initialDelayMs: 20_000,
    run: () => require('./unsubscribeRotationService').rotateAll({ trigger: 'scheduled' }),
  });

  scheduler.register('holiday-carry-over', {
    description: "Roll unused holiday entitlement into the new holiday year, capped by each employee's carry-over policy.",
    intervalMs: DAY,
    run: () => require('./holidayCarryOverService').applyCarryOverOnce(),
  });
}

function start() {
  registerAll();
  scheduler.start();
}

module.exports = { start, registerAll };
