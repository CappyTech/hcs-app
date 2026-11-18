// Admin: the system's health beside Users. Each node's list is an admin page
// guarded by its route (rolePermissionsConfig), so access follows `listRoute`
// and every figure opens that page. None has an overview of its own: the
// cards on /overview/admin are the summary, the page behind each is the detail.
const OPEN_GDPR = { status: { $in: ['pending', 'under_review', 'approved'] } };
const CHANGES = { op: { $in: ['create', 'update', 'delete'] } };

export default [
  {
    id: 'securityEvent',
    model: 'securityEvent',
    label: { one: 'Security event', many: 'Security events' },
    icon: 'bi-shield-exclamation',
    description: 'Failed sign-ins, lockouts and changes to roles and two-factor sign-in.',
    parents: ['admin'],
    listPath: '/admin/security-events',
    listRoute: '/admin/security-events',
    figures: {
      failed7: { label: 'Failed sign-ins, last 7 days', severity: 'warning', where: { type: 'login_failed', createdAt: { $withinPastDays: 7 } } },
      locked7: { label: 'Accounts locked, last 7 days', severity: 'critical', where: { type: 'account_locked', createdAt: { $withinPastDays: 7 } } },
      roles30: { label: 'Role changes, last 30 days', where: { type: { $in: ['role_changed', 'job_role_added', 'job_role_changed', 'job_role_reset', 'job_role_deleted'] }, createdAt: { $withinPastDays: 30 } } },
      totpOff30: { label: 'Two-factor turned off, last 30 days', severity: 'warning', where: { type: 'totp_disabled', createdAt: { $withinPastDays: 30 } } },
    },
    summary: ['failed7', 'locked7', 'totpOff30', 'roles30'],
  },
  {
    id: 'jobState',
    model: 'jobState',
    label: { one: 'Background job', many: 'Background jobs' },
    icon: 'bi-gear-wide-connected',
    description: 'Scheduled tasks and whether their last run worked.',
    parents: ['admin'],
    listPath: '/admin/jobs',
    listRoute: '/admin/jobs',
    figures: {
      all: { label: 'Jobs', where: {} },
      failing: { label: 'Last run failed', severity: 'critical', where: { lastOutcome: 'error' } },
      idle: { label: 'Not run for a day', hint: 'Last ran over 24 hours ago', severity: 'warning', where: { lastRunAt: { $notAfterDays: -1 } } },
    },
    summary: ['all', 'failing', 'idle'],
  },
  {
    id: 'notification',
    model: 'notification',
    label: { one: 'Notification', many: 'Notifications' },
    icon: 'bi-envelope',
    description: 'The email and notification outbox: what is waiting, sent and given up on.',
    parents: ['admin'],
    listPath: '/admin/emails/outbox',
    listRoute: '/admin/emails',
    figures: {
      failed: { label: 'Given up on', hint: 'Out of retries; can be re-sent from the outbox', severity: 'critical', where: { status: 'failed' } },
      waiting: { label: 'Waiting to send', where: { status: 'pending' } },
      stuck: { label: 'Waiting over an hour', severity: 'warning', where: { status: 'pending', createdAt: { $notAfterDays: -1 / 24 } } },
      sent7: { label: 'Sent, last 7 days', where: { status: 'sent', sentAt: { $withinPastDays: 7 } } },
    },
    summary: ['failed', 'stuck', 'waiting', 'sent7'],
  },
  {
    id: 'auditLog',
    model: 'auditLog',
    label: { one: 'Audit log entry', many: 'Audit log entries' },
    icon: 'bi-journal-check',
    description: 'Every record change and sensitive read, and who made it.',
    parents: ['admin'],
    listPath: '/audit',
    listRoute: '/audit',
    figures: {
      changes1: { label: 'Changes, last 24 hours', where: { ...CHANGES, at: { $withinPastDays: 1 } } },
      deletes7: { label: 'Deletions, last 7 days', severity: 'warning', where: { op: 'delete', at: { $withinPastDays: 7 } } },
      reads7: { label: 'Sensitive reads, last 7 days', where: { op: 'read', at: { $withinPastDays: 7 } } },
    },
    summary: ['changes1', 'deletes7', 'reads7'],
  },
  {
    id: 'gdprRequest',
    model: 'gdprRequest',
    label: { one: 'GDPR request', many: 'GDPR requests' },
    icon: 'bi-person-lock',
    description: 'Access, correction and erasure requests and their 30-day deadline.',
    parents: ['admin'],
    listPath: '/admin/gdpr/requests',
    listRoute: '/admin/gdpr/requests',
    figures: {
      open: { label: 'Open requests', where: OPEN_GDPR },
      overdue: { label: 'Past the 30-day deadline', severity: 'critical', where: { ...OPEN_GDPR, deadline: { $beforeNow: true } } },
      completed90: { label: 'Completed, last 90 days', where: { status: 'completed', completedAt: { $withinPastDays: 90 } } },
    },
    summary: ['open', 'overdue', 'completed90'],
  },
];
