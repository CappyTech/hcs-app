import mdb from './mongooseDatabaseService.js';
import taskService from './taskService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';
import accessGroups from '../config/accessGroupsConfig.js';

const DEFAULT_DAYS_AHEAD = 30;
const KEY_PREFIX = 'training:';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Health & Safety expiry reminders (phase 5a) — mirrors hrComplianceService.
 *
 * Scans training records (cards, tickets, certificates) expired or expiring
 * within `daysAhead` days. Each (record, expiry date) is one reminder task
 * given to everyone who looks after Health & Safety: admins, and users holding
 * a job role with the Health & Safety area at edit or above. Completing any
 * copy completes them all; EXPIRING turns into EXPIRED on the same task; once
 * the date is updated (or the record deleted) the task closes itself.
 *
 * Newly flagged items go out in one daily summary email to the same people,
 * and the person who holds the card gets their own email (if their account
 * is linked to the employee or subcontractor and their email is verified).
 */

/** Job roles that look after Health & Safety (area at edit or above, role on). */
export function healthSafetyJobRoles() {
  const minLevel = accessGroups.LEVELS.indexOf('edit');
  return Object.entries(accessGroups.jobRoles)
    .filter(([slug]) => accessGroups.isJobRoleAvailable(slug))
    .filter(([, def]) => (def.grants || []).some((g) => g.group === 'healthSafety'
      && (g.scope || 'all') === 'all'
      && accessGroups.LEVELS.indexOf(g.level) >= minLevel))
    .map(([slug]) => slug);
}

/** Users who receive the reminders: admins plus Health & Safety job roles. */
async function healthSafetyUsers(User) {
  const jobRoles = healthSafetyJobRoles();
  const or = [{ role: 'admin' }];
  if (jobRoles.length) or.push({ roles: { $in: jobRoles } });
  return User.find({ $or: or }).select('_id email emailVerified').lean();
}

function holderName(rec, names) {
  const base = rec.employeeId
    ? names.employees.get(String(rec.employeeId))
    : names.suppliers.get(String(rec.subcontractorId));
  if (rec.personName) return base ? `${rec.personName} (${base})` : rec.personName;
  return base || 'Unknown holder';
}

function recordLabel(rec) {
  return rec.title ? `${rec.type} (${rec.title})` : rec.type;
}

async function loadNames(records) {
  const employeeIds = [...new Set(records.filter((r) => r.employeeId).map((r) => String(r.employeeId)))];
  const supplierIds = [...new Set(records.filter((r) => r.subcontractorId).map((r) => String(r.subcontractorId)))];
  const employees = new Map();
  const suppliers = new Map();
  if (employeeIds.length && mdb.INTERNAL?.employee) {
    for (const e of await mdb.INTERNAL.employee.find({ _id: { $in: employeeIds } }).select('name').lean()) {
      employees.set(String(e._id), e.name);
    }
  }
  if (supplierIds.length && mdb.REST?.supplier) {
    for (const s of await mdb.REST.supplier.find({ _id: { $in: supplierIds } }).select('Name').lean()) {
      suppliers.set(String(s._id), s.Name);
    }
  }
  return { employees, suppliers };
}

/** The holder's own account, when it is linked and can receive email. */
async function holderUser(User, rec) {
  const q = rec.employeeId ? { employeeId: rec.employeeId } : { subcontractorId: rec.subcontractorId };
  // A named operative of a subcontractor firm is not the firm's account holder.
  if (!rec.employeeId && rec.personName) return null;
  return User.findOne({ ...q, email: { $nin: [null, ''] }, emailVerified: true }).select('_id email').lean();
}

async function checkExpiriesAndCreateTasks({ daysAhead = DEFAULT_DAYS_AHEAD, now = new Date() } = {}) {
  const stats = { created: 0, skipped: 0, errors: 0 };
  const newAlerts = [];

  const Training = mdb.INTERNAL?.trainingRecord;
  const User = mdb.INTERNAL?.user;
  if (!Training || !User) {
    logger.warn('[healthSafetyComplianceService] Training record or User model not available — skipping.');
    return stats;
  }

  const recipients = await healthSafetyUsers(User);
  if (!recipients.length) {
    logger.warn('[healthSafetyComplianceService] Nobody looks after Health & Safety — cannot create tasks.');
    return stats;
  }
  const userIds = recipients.map((u) => u._id);
  const horizon = new Date(now.getTime() + daysAhead * DAY_MS);
  const currentKeys = new Set();

  const records = await Training.find({ expiryDate: { $ne: null, $lte: horizon } }).lean();
  const names = await loadNames(records);

  for (const rec of records) {
    const date = new Date(rec.expiryDate);
    const isExpired = date < now;
    const daysLeft = Math.ceil((date - now) / DAY_MS);
    const dateStr = date.toISOString().slice(0, 10);
    const systemKey = `${KEY_PREFIX}${rec._id}:${dateStr}`;
    currentKeys.add(systemKey);

    const who = holderName(rec, names);
    const what = recordLabel(rec);
    const subject = `${what} – ${who}`;
    const title = `[${isExpired ? 'EXPIRED' : 'EXPIRING'}] ${subject}`;
    const description = `${who}: ${what} ${isExpired ? 'expired' : 'expires'} on ${dateStr}. Renew it and update the training record; this task closes itself once the date is updated.`;
    const suffix = isExpired ? `expired ${Math.abs(daysLeft)} day(s) ago` : `expires in ${daysLeft} day(s)`;

    try {
      const r = await taskService.ensureSystemTask({
        systemKey,
        title,
        legacyTitles: [`[EXPIRED] ${subject}`, `[EXPIRING] ${subject}`],
        description,
        dueDate: date,
        priority: isExpired ? 'high' : 'normal',
        userIds,
      });
      stats.created += r.created;
      stats.skipped += r.skipped;
      if (r.created > 0 || r.updated > 0) {
        newAlerts.push(`${who} — ${what} ${suffix}`);
        await notifyHolder(User, rec, { what, dateStr, isExpired });
      }
    } catch (err) {
      logger.error(`[healthSafetyComplianceService] Failed to create task for ${rec.uuid}: ${err.message}`);
      stats.errors++;
    }
  }

  // Only a complete scan can say a reminder no longer applies.
  if (stats.errors === 0) {
    try {
      stats.resolved = await taskService.resolveStaleSystemTasks(KEY_PREFIX, currentKeys);
    } catch (err) {
      logger.error(`[healthSafetyComplianceService] Failed to close resolved tasks: ${err.message}`);
    }
  }

  if (newAlerts.length > 0) {
    const today = now.toISOString().slice(0, 10);
    const html = notificationService.wrapTemplate({
      heading: 'Training & Cards',
      bodyLines: ['These cards and training records are expired or expire within 30 days:', ...newAlerts],
      ctaText: 'Open Training & Cards',
      ctaUrl: `${notificationService.baseUrl()}/overview/trainingRecord`,
    });
    const text = ['Cards and training expired or expiring soon:', ...newAlerts].join('\n');
    for (const u of recipients) {
      if (!u.email || !u.emailVerified) continue;
      try {
        await notificationService.enqueue({
          to: u.email,
          recipientUserId: u._id,
          subject: `Health & Safety: ${newAlerts.length} card(s) or training need attention`,
          html, text,
          category: 'health-safety',
          dedupeKey: `training-expiry-${today}:${u.email}`,
        });
      } catch (err) {
        logger.error(`[healthSafetyComplianceService] Failed to queue summary email: ${err.message}`);
      }
    }
  }

  if (stats.created > 0 || stats.errors > 0 || stats.resolved > 0) {
    logger.info(`[healthSafetyComplianceService] Check complete: ${stats.created} tasks created, ${stats.skipped} skipped, ${stats.resolved || 0} closed, ${stats.errors} errors.`);
  }
  return stats;
}

async function notifyHolder(User, rec, { what, dateStr, isExpired }) {
  try {
    const user = await holderUser(User, rec);
    if (!user) return;
    const line = `Your ${what} ${isExpired ? 'expired' : 'expires'} on ${dateStr}. Please arrange to renew it and send the new card or certificate to the office.`;
    await notificationService.enqueue({
      to: user.email,
      recipientUserId: user._id,
      subject: `Your ${what} ${isExpired ? 'has expired' : 'is about to expire'}`,
      html: notificationService.wrapTemplate({ heading: 'Training & Cards', bodyLines: [line] }),
      text: line,
      category: 'health-safety',
      dedupeKey: `training-holder-${rec._id}:${dateStr}:${isExpired ? 'expired' : 'expiring'}`,
    });
  } catch (err) {
    logger.error(`[healthSafetyComplianceService] Failed to email the holder of ${rec.uuid}: ${err.message}`);
  }
}

export default {
  checkExpiriesAndCreateTasks,
  healthSafetyJobRoles,
};
