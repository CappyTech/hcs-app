import scheduler from './jobSchedulerService.js';
import __sessionCleanupService from './sessionCleanupService.js';
import __notificationService from '../../services/notificationService.js';
import __vehicleComplianceService from './vehicleComplianceService.js';
import __ocrOrphanService from './ocrOrphanService.js';
import __cisReturnReminderService from './cisReturnReminderService.js';
import __gdprDeadlineService from './gdprDeadlineService.js';
import __deletedItemsPurgeService from './deletedItemsPurgeService.js';
import __holidayService from './holidayService.js';
import __hrComplianceService from './hrComplianceService.js';
import __policyReviewReminderService from './policyReviewReminderService.js';
import __unsubscribeRotationService from './unsubscribeRotationService.js';
import __holidayCarryOverService from './holidayCarryOverService.js';
import __bankWorklistService from './bankWorklistService.js';
import __bankRuleService from './bankRuleService.js';
import __bankTransferService from './bankTransferService.js';
import __bankThreeWayService from './bankThreeWayService.js';

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
    run: () => __sessionCleanupService.cleanupOnce(),
  });

  scheduler.register('notification-outbox', {
    description: 'Deliver queued email notifications with retry/backoff.',
    intervalMs: MINUTE,
    initialDelayMs: 15_000,
    run: () => __notificationService.processOutbox(),
  });

  scheduler.register('bank-link-resolve', {
    description:
      'Turn KashFlow\'s own bank-line links into reviewable match suggestions. '
      + 'Suggests only — nothing is confirmed automatically, and KashFlow is never written to.',
    intervalMs: 6 * HOUR,
    // Idempotent: a bank line that already has any match record is skipped, so
    // re-running neither duplicates suggestions nor churns the audit log.
    run: () => __bankWorklistService.generateSuggestions(),
  });

  scheduler.register('bank-rule-apply', {
    description:
      'Classify bank lines that settle no document - wages, tax, pension, loan '
      + 'repayments, charges - using the accountant\'s rules, plus internal '
      + 'transfers and movements between our own accounts. Suggests only, unless '
      + 'a rule is explicitly set to confirm automatically.',
    intervalMs: 6 * HOUR,
    initialDelayMs: 30_000,
    run: async () => {
      // Order matters: paired transfers and account-named movements are
      // stronger explanations than a rule, and each step skips lines already
      // claimed, so whichever runs first wins.
      const paired = await __bankTransferService.detectTransfers();
      const moved = await __bankTransferService.detectAccountNamedMovements();
      const ruled = await __bankRuleService.applyRules();
      return {
        transfers: paired.created,
        movements: moved.created,
        rules: ruled.created,
        stillUnmatched: ruled.unmatched,
      };
    },
  });

  scheduler.register('bank-statement-reconcile', {
    description:
      'Match imported bank statement lines against KashFlow transactions. '
      + 'Surfaces money that moved but was never booked - the one discrepancy '
      + 'reconciling KashFlow against itself cannot find. No-op until a '
      + 'statement whose running balance verified has been imported.',
    intervalMs: 6 * HOUR,
    initialDelayMs: 45_000,
    run: () => __bankThreeWayService.reconcileStatements(),
  });

  scheduler.register('vehicle-compliance', {
    description: 'Create tasks and email alerts for vehicles with MOT/insurance/road tax expiring within 30 days.',
    intervalMs: DAY,
    run: () => __vehicleComplianceService.checkComplianceAndCreateTasks(),
  });

  scheduler.register('ocr-orphans', {
    description: 'Clear KashFlow links on OCR documents whose purchase has been deleted (docs sent in the last 48 h are held). Manual only — run from this page or the Documents overview.',
    intervalMs: null, // manual-only: admin decides when stale links are cleared
    run: () => __ocrOrphanService.detectAndClearOrphans(),
  });

  scheduler.register('cis-return-reminder', {
    description: 'Email admin/accountant users 7 and 2 days before the CIS monthly return deadline (19th).',
    intervalMs: 12 * HOUR,
    run: () => __cisReturnReminderService.checkAndQueueReminders(),
  });

  scheduler.register('gdpr-deadlines', {
    description: 'Alert admins when GDPR requests approach or pass their 30-day statutory deadline.',
    intervalMs: 12 * HOUR,
    run: () => __gdprDeadlineService.checkDeadlines(),
  });

  scheduler.register('deleted-items-purge', {
    description: 'Permanently remove soft-deleted records past retention (requires DELETED_ITEMS_RETENTION_DAYS; off by default).',
    intervalMs: DAY,
    run: () => __deletedItemsPurgeService.purgeOnce(),
  });

  scheduler.register('bank-holiday-sync', {
    description: 'Sync UK bank holidays from the GOV.UK feed into the Government Holidays list.',
    intervalMs: 7 * DAY,
    run: () => __holidayService.syncBankHolidays(),
  });

  scheduler.register('hr-compliance', {
    description: 'Create tasks and email alerts for employee contracts and right-to-work checks expiring within 30 days.',
    intervalMs: DAY,
    run: () => __hrComplianceService.checkExpiriesAndCreateTasks(),
  });

  scheduler.register('policy-review-reminder', {
    description: 'Email admins when company policies reach their review date (30-day warning).',
    intervalMs: DAY,
    run: () => __policyReviewReminderService.checkAndQueueReminders(),
  });

  scheduler.register('unsubscribe-token-rotation', {
    description: "Rotate every user's unsubscribe token so email unsubscribe links expire ~daily. Runs on startup (if due) and every 24h; enable/disable and last-run are on the Email & Notifications admin page.",
    intervalMs: DAY,
    initialDelayMs: 20_000,
    run: () => __unsubscribeRotationService.rotateAll({ trigger: 'scheduled' }),
  });

  scheduler.register('holiday-carry-over', {
    description: "Roll unused holiday entitlement into the new holiday year, capped by each employee's carry-over policy.",
    intervalMs: DAY,
    run: () => __holidayCarryOverService.applyCarryOverOnce(),
  });
}

function start() {
  registerAll();
  scheduler.start();
}

export default { start, registerAll };
