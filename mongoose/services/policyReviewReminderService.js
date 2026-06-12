'use strict';

const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');

const DEFAULT_DAYS_AHEAD = 30;

/**
 * Policy review-date reminders.
 *
 * Emails admins one daily summary (via the notification outbox) listing
 * company policies whose `reviewDate` has passed or falls within the next
 * `daysAhead` days. Deduped per day, so the reminder repeats daily until the
 * review date is updated.
 */
async function checkAndQueueReminders({ daysAhead = DEFAULT_DAYS_AHEAD } = {}) {
  const stats = { due: 0, queued: 0 };

  const PolicyDocument = mdb.INTERNAL?.policyDocument;
  if (!PolicyDocument) {
    logger.warn('[policyReviewReminderService] policyDocument model not available — skipping.');
    return stats;
  }

  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + daysAhead);

  const duePolicies = await PolicyDocument.find({
    reviewDate: { $ne: null, $lte: horizon },
  }).sort({ reviewDate: 1 }).lean();

  stats.due = duePolicies.length;
  if (!duePolicies.length) return stats;

  const lines = duePolicies.map((p) => {
    const date = new Date(p.reviewDate);
    const overdue = date < now;
    const when = date.toISOString().slice(0, 10);
    return `${p.title} (v${p.version || '1.0'}, ${p.category || 'General'}) — review ${overdue ? 'overdue since' : 'due'} ${when}`;
  });

  try {
    const notificationService = require('../../services/notificationService');
    const today = now.toISOString().slice(0, 10);
    const result = await notificationService.enqueueForRoles(['admin'], {
      subject: `Policy review: ${duePolicies.length} polic${duePolicies.length === 1 ? 'y' : 'ies'} due for review`,
      html: notificationService.wrapTemplate({
        heading: 'Policy Review Reminders',
        bodyLines: [
          'The following policies have reached (or are approaching) their review date:',
          ...lines,
        ],
        ctaText: 'Open Policies',
        ctaUrl: `${notificationService.baseUrl()}/company-docs/policies`,
      }),
      text: ['Policies due for review:', ...lines].join('\n'),
      category: 'policy',
      dedupeKey: `policy-review-${today}`,
    });
    stats.queued = result.queued || 0;
  } catch (err) {
    logger.error(`[policyReviewReminderService] Failed to queue reminder email: ${err.message}`);
  }

  return stats;
}

module.exports = {
  checkAndQueueReminders,
};
