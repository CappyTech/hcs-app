'use strict';

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

const logger = require('../../services/loggerService');

// senderType: 'system' | 'admin'
// subscribable: recipients may unsubscribe
// defaultOn: default subscription state when no explicit preference exists
const DEFAULT_TYPES = [
  // ── System notifications (automated jobs / workflows) ───────────────
  { key: 'task-assigned',   label: 'Task assigned',        description: 'A task has been created and assigned to you.',                       senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'task-due',        label: 'Task due / overdue',   description: 'Reminder that one of your tasks is due or overdue.',                 senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'holiday',         label: 'Holiday requests',     description: 'Holiday request submissions, approvals and rejections.',             senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'cis',             label: 'CIS return reminders', description: 'Reminders before the monthly CIS return deadline.',                  senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'gdpr',            label: 'GDPR deadlines',       description: 'Alerts when GDPR requests approach their statutory deadline.',       senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'hr',              label: 'HR compliance',        description: 'Contract and right-to-work expiry alerts.',                          senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'policy',          label: 'Policy reviews',       description: 'Reminders when company policies reach their review date.',           senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'vehicle',         label: 'Fleet compliance',     description: 'MOT, insurance and road-tax expiry alerts for company vehicles.',    senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'system',          label: 'System notices',       description: 'General automated platform notices.',                                senderType: 'system', subscribable: true,  defaultOn: true },
  { key: 'security',        label: 'Security alerts',      description: 'Security-critical notices (mandatory — cannot be unsubscribed).',    senderType: 'system', subscribable: false, defaultOn: true },
  { key: 'system-broadcast',label: 'System broadcast',     description: 'Broadcast system announcements sent to many users at once.',         senderType: 'system', subscribable: true,  defaultOn: true },

  // ── Admin-originated ────────────────────────────────────────────────
  { key: 'admin-message',   label: 'Message from an administrator', description: 'A direct email sent to you by an administrator.',           senderType: 'admin',  subscribable: false, defaultOn: true },
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

module.exports = { ensureSeeded, DEFAULT_TYPES };
