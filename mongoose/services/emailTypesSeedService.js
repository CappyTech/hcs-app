/**
 * emailTypesSeedService.js
 *
 * Ensures the emailType catalog holds a document for every core type the
 * platform's code depends on. Runs at startup (app.js Phase 2), mirroring
 * payrollTaxRatesSeedService.
 *
 * Semantics:
 *  - INSERT-ONLY: an existing type (matched by `key`) is never overwritten, so
 *    label/enabled/subscribable edits made by an admin in
 *    Settings → Emails survive restarts and deploys.
 *  - The keys below cover the categories current callers already pass to
 *    notificationService.enqueueForRoles (holiday, cis, gdpr, hr, policy,
 *    vehicle, security, system) plus the new granular task + broadcast types.
 */

import logger from '../../services/loggerService.js';

// senderType: 'system' | 'admin'
// subscribable: recipients may unsubscribe
// defaultOn: default subscription state when no explicit preference exists
// `heading` / `intro` are the H2 and opening paragraph shown in the admin
// preview and in admin-composed messages of this type. Automated system senders
// build their own body, so revising these does not change their live emails.
const DEFAULT_TYPES = [
  // ── System notifications (automated jobs / workflows) ───────────────
  {
    key: 'task-assigned', label: 'Task assigned', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'A task has been assigned to you.',
    heading: "You've been assigned a task",
    intro: 'A new task has been added to your list and needs your attention.',
  },
  {
    key: 'task-due', label: 'Task reminders', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Reminders that a task is due soon or overdue.',
    heading: 'Task due soon',
    intro: 'One of your tasks is approaching its due date or is now overdue.',
  },
  {
    key: 'holiday', label: 'Holiday requests', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Updates on holiday requests you submit or need to review.',
    heading: 'Holiday request update',
    intro: "There's an update on a holiday request.",
  },
  {
    key: 'cis', label: 'CIS return reminders', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Reminders ahead of the monthly CIS return deadline.',
    heading: 'CIS return due',
    intro: 'The monthly CIS return deadline is approaching.',
  },
  {
    key: 'gdpr', label: 'GDPR deadlines', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Alerts as data-subject requests approach their statutory deadline.',
    heading: 'GDPR deadline approaching',
    intro: 'A data-subject request is nearing its statutory deadline.',
  },
  {
    key: 'hr', label: 'HR compliance', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Contract and right-to-work expiry alerts.',
    heading: 'HR compliance alert',
    intro: 'An HR compliance item needs attention.',
  },
  {
    key: 'policy', label: 'Policy reviews', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Reminders when a company policy reaches its review date.',
    heading: 'Policy review due',
    intro: 'A company policy has reached its scheduled review date.',
  },
  {
    key: 'vehicle', label: 'Fleet compliance', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'MOT, insurance and road-tax expiry alerts for company vehicles.',
    heading: 'Fleet compliance alert',
    intro: 'One or more vehicles have compliance items expiring soon.',
  },
  {
    key: 'system', label: 'System notices', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'General automated notices from the platform.',
    heading: 'System notice',
    intro: 'This is an automated notice from the platform.',
  },
  {
    key: 'security', label: 'Security alerts', senderType: 'system', subscribable: false, defaultOn: true,
    description: 'Security-critical notices (mandatory — cannot be unsubscribed).',
    heading: 'Security alert',
    intro: 'This is a security notice about your account.',
  },
  {
    key: 'system-broadcast', label: 'Announcements', senderType: 'system', subscribable: true, defaultOn: true,
    description: 'Platform-wide announcements sent to many users at once.',
    heading: 'Announcement',
    intro: "There's a new platform announcement.",
  },

  // ── Admin-originated ────────────────────────────────────────────────
  {
    key: 'admin-message', label: 'Message from an administrator', senderType: 'admin', subscribable: false, defaultOn: true,
    description: 'A direct email sent to you by an administrator.',
    heading: 'Message from an administrator',
    intro: 'An administrator has sent you a message.',
  },
];

/**
 * Idempotently insert any missing core types. Returns the keys created.
 * @param {import('mongoose').Model} EmailType
 */
async function ensureSeeded(EmailType) {
  if (!EmailType) return { created: [] };
  const created = [];
  for (const def of DEFAULT_TYPES) {
    const existing = await EmailType.findOne({ key: def.key }).select('_id').lean();
    if (existing) continue;
    await EmailType.create({ ...def, enabled: true, isCore: true });
    created.push(def.key);
  }
  if (created.length) {
    logger.info(`[emailTypesSeed] Seeded core email types: ${created.join(', ')}`);
  }
  return { created };
}

export default { ensureSeeded, DEFAULT_TYPES };
