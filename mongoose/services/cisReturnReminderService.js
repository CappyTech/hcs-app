import notificationService from '../../services/notificationService.js';

/**
 * CIS monthly-return deadline reminders.
 *
 * CIS tax months run 6th → 5th; the CIS300 return for the month ended on the
 * 5th is due to HMRC by the 19th of the same calendar month. This job runs
 * daily and emails admin + accountant users 7 days and 2 days before each
 * deadline, and once on the day after if the period has passed. The outbox
 * dedupe key makes every reminder fire exactly once per period/threshold.
 */

const REMINDER_THRESHOLD_DAYS = [7, 2];

/** The next (or current) CIS return deadline on/after `from`, at local midnight. */
function nextDeadline(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), 19);
  if (d < new Date(from.getFullYear(), from.getMonth(), from.getDate())) {
    return new Date(from.getFullYear(), from.getMonth() + 1, 19);
  }
  return d;
}

/** Label for the tax period the deadline covers, e.g. '6 May – 5 Jun 2026'. */
function periodLabel(deadline) {
  const end = new Date(deadline.getFullYear(), deadline.getMonth(), 5);
  const start = new Date(deadline.getFullYear(), deadline.getMonth() - 1, 6);
  const fmt = (dt, withYear) =>
    dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

function periodKey(deadline) {
  return `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}`;
}

/** Daily check; enqueues reminders when a threshold is hit. */
async function checkAndQueueReminders(now = new Date()) {
  const deadline = nextDeadline(now);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysUntil = Math.round((deadline - today) / (24 * 60 * 60 * 1000));

  if (!REMINDER_THRESHOLD_DAYS.includes(daysUntil)) {
    return { queued: 0, daysUntil, deadline: deadline.toISOString().slice(0, 10) };
  }

  const label = periodLabel(deadline);
  const deadlineStr = deadline.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const subject = `CIS return due ${deadlineStr} — ${daysUntil} day${daysUntil === 1 ? '' : 's'} left`;
  const bodyLines = [
    `The CIS monthly return for the tax period ${label} is due to HMRC by ${deadlineStr}.`,
    'Please ensure all subcontractor payments and deductions for the period are recorded, then submit the return.',
    'Remember: payment of deductions to HMRC is due by the 22nd if paying electronically.',
  ];

  const result = await notificationService.enqueueForRoles(['admin', 'accountant'], {
    subject,
    html: notificationService.wrapTemplate({
      heading: 'CIS Return Reminder',
      bodyLines,
      ctaText: 'Open CIS Dashboard',
      ctaUrl: `${notificationService.baseUrl()}/CIS/Dashboard/`,
    }),
    text: bodyLines.join('\n\n'),
    category: 'cis',
    dedupeKey: `cis-return-${periodKey(deadline)}-${daysUntil}d`,
  });

  return { ...result, daysUntil, deadline: deadline.toISOString().slice(0, 10) };
}

export default { checkAndQueueReminders, nextDeadline, periodLabel };
