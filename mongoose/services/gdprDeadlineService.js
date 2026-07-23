import mdb from './mongooseDatabaseService.js';
import notificationService from '../../services/notificationService.js';

/**
 * GDPR request deadline tracking.
 *
 * Data subject requests carry a 30-day statutory deadline (UK GDPR Art. 12(3),
 * set on the model). This daily job alerts admins when an open request enters
 * the 7-day warning window and again if it becomes overdue. Dedupe keys ensure
 * one email per request per stage.
 */

const OPEN_STATUSES = ['pending', 'under_review', 'approved'];
const WARNING_DAYS = 7;

async function checkDeadlines(now = new Date()) {
  const GdprRequest = mdb.INTERNAL?.gdprRequest;
  if (!GdprRequest) return { warned: 0, overdue: 0 };

  const horizon = new Date(now.getTime() + WARNING_DAYS * 24 * 60 * 60 * 1000);
  const requests = await GdprRequest.find({
    status: { $in: OPEN_STATUSES },
    deadline: { $lte: horizon },
  }).populate('requestedBy', 'username email').lean();

  const stats = { warned: 0, overdue: 0 };
  const base = notificationService.baseUrl();

  for (const reqDoc of requests) {
    const isOverdue = reqDoc.deadline < now;
    const stage = isOverdue ? 'overdue' : 'due-soon';
    const daysLeft = Math.ceil((reqDoc.deadline - now) / (24 * 60 * 60 * 1000));
    const who = reqDoc.requestedBy?.username || 'unknown user';
    const deadlineStr = new Date(reqDoc.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const subject = isOverdue
      ? `OVERDUE: GDPR ${reqDoc.type} request from ${who} (deadline ${deadlineStr})`
      : `GDPR ${reqDoc.type} request from ${who} due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;

    const bodyLines = [
      `A ${reqDoc.type} request submitted by ${who} has a statutory response deadline of ${deadlineStr}.`,
      isOverdue
        ? 'The 30-day deadline has passed. Respond immediately and record the delay reason — the ICO expects justification for late responses.'
        : 'Please review and respond before the deadline to remain within the 30-day statutory window.',
      `Current status: ${reqDoc.status}.`,
    ];

    const result = await notificationService.enqueueForRoles(['admin'], {
      subject,
      html: notificationService.wrapTemplate({
        heading: isOverdue ? 'GDPR Request Overdue' : 'GDPR Request Deadline Approaching',
        bodyLines,
        ctaText: 'Review Request',
        ctaUrl: `${base}/admin/gdpr`,
      }),
      text: bodyLines.join('\n\n'),
      category: 'gdpr',
      refType: 'gdprRequest',
      refId: reqDoc._id,
      dedupeKey: `gdpr-${stage}-${reqDoc._id}`,
    });

    if (result.queued > 0) stats[isOverdue ? 'overdue' : 'warned']++;
  }

  return stats;
}

export default { checkDeadlines };
