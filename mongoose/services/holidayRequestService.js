'use strict';

const mdb = require('./mongooseDatabaseService');
const notificationService = require('../../services/notificationService');
const logger = require('../../services/loggerService');

/**
 * Holiday request workflow: notifications on submission and decision, and
 * keeping employeeHoliday.takenDays in sync with approvals.
 * Wired into the generic CRUD pipeline via the holidayRequest entry in
 * CRUDControllerConfig (afterCreate / afterUpdate hooks).
 */

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function employeeName(employeeId) {
  const emp = await mdb.INTERNAL.employee.findById(employeeId).select('name').lean();
  return emp?.name || 'Unknown employee';
}

/** Email the employee's linked user account, if it has a verified address. */
async function notifyEmployee(employeeId, { subject, heading, bodyLines, ctaUrl }) {
  const user = await mdb.INTERNAL.user.findOne({
    employeeId,
    email: { $nin: [null, ''] },
    emailVerified: true,
  }).select('email').lean();
  if (!user) {
    logger.info(`[holidayRequestService] No verified user email for employee ${employeeId} — decision email skipped`);
    return null;
  }
  return notificationService.enqueue({
    to: user.email,
    subject,
    html: notificationService.wrapTemplate({ heading, bodyLines, ctaText: 'View Requests', ctaUrl }),
    text: bodyLines.join('\n\n'),
    category: 'holiday',
  });
}

/** afterCreate hook: tell admins a new request needs review. */
async function notifyNewRequest(doc) {
  const name = await employeeName(doc.employeeId);
  const range = `${fmtDate(doc.startDate)} – ${fmtDate(doc.endDate)} (${doc.daysRequested} day${doc.daysRequested === 1 ? '' : 's'})`;
  await notificationService.enqueueForRoles(['admin'], {
    subject: `Holiday request: ${name}, ${range}`,
    html: notificationService.wrapTemplate({
      heading: 'New Holiday Request',
      bodyLines: [
        `${name} has requested ${doc.leaveType} leave for ${range}.`,
        doc.reason ? `Reason: ${doc.reason}` : 'No reason given.',
        'Please review and approve or reject the request.',
      ],
      ctaText: 'Review Request',
      ctaUrl: `${notificationService.baseUrl()}/holidayRequests`,
    }),
    text: `${name} has requested ${doc.leaveType} leave for ${range}.`,
    category: 'holiday',
    refType: 'holidayRequest',
    refId: doc._id,
    dedupeKey: `holiday-new-${doc._id}`,
  });
}

/**
 * Adjust employeeHoliday.takenDays when a request's approval state changes.
 * Annual leave only — unpaid/other leave never consumes entitlement.
 */
async function adjustTakenDays(doc, direction) {
  if (doc.leaveType !== 'annual') return;
  const period = await mdb.INTERNAL.employeeHoliday.findOne({
    employeeId: doc.employeeId,
    periodStart: { $lte: doc.startDate },
    periodEnd: { $gte: doc.startDate },
  });
  if (!period) {
    logger.warn(`[holidayRequestService] No employeeHoliday period covers ${fmtDate(doc.startDate)} for employee ${doc.employeeId} — takenDays not adjusted`);
    return;
  }
  period.takenDays = Math.max(0, (period.takenDays || 0) + direction * doc.daysRequested);
  await period.save();
}

/** afterUpdate hook: react to status transitions. */
async function handleStatusChange(updated, previous, req) {
  const before = previous?.status;
  const after = updated.status;
  if (!before || before === after) return;

  // Stamp the reviewer on decisions made via the generic CRUD form
  if (['approved', 'rejected'].includes(after) && !updated.reviewedAt) {
    updated.reviewedBy = req?.user?._id || updated.reviewedBy;
    updated.reviewedAt = new Date();
    await updated.save();
  }

  // Keep entitlement totals in sync
  if (before !== 'approved' && after === 'approved') await adjustTakenDays(updated, +1);
  if (before === 'approved' && after !== 'approved') await adjustTakenDays(updated, -1);

  // Tell the employee about decisions
  if (['approved', 'rejected'].includes(after)) {
    const range = `${fmtDate(updated.startDate)} – ${fmtDate(updated.endDate)}`;
    await notifyEmployee(updated.employeeId, {
      subject: `Your holiday request for ${range} was ${after}`,
      heading: after === 'approved' ? 'Holiday Request Approved' : 'Holiday Request Rejected',
      bodyLines: [
        `Your ${updated.leaveType} leave request for ${range} (${updated.daysRequested} day${updated.daysRequested === 1 ? '' : 's'}) has been ${after}.`,
        updated.reviewNotes ? `Notes: ${updated.reviewNotes}` : null,
      ].filter(Boolean),
      ctaUrl: `${notificationService.baseUrl()}/holidayRequests`,
    });
  }
}

module.exports = { notifyNewRequest, handleStatusChange, adjustTakenDays };
