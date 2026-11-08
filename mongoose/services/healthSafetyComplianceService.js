import mdb from './mongooseDatabaseService.js';
import taskService from './taskService.js';
import logger from '../../services/loggerService.js';
import notificationService from '../../services/notificationService.js';
import accessGroups from '../config/accessGroupsConfig.js';

const DEFAULT_DAYS_AHEAD = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Health & Safety expiry reminders — mirrors hrComplianceService.
 *
 * Scans records with an expiry date that has passed or falls within
 * `daysAhead` days:
 *  • training records (cards, tickets, certificates; phase 5a)
 *  • site inductions due again (phase 5b)
 *  • approved RAMS due for review (phase 5c; `reviewDate`, no person)
 *
 * Each (record, expiry date) is one reminder task given to everyone who looks
 * after Health & Safety: admins, and users holding a job role with the Health
 * & Safety area at edit or above on every site. A re-induction or a RAMS
 * review also goes to the contract's site managers. Completing any copy completes them all;
 * EXPIRING turns into EXPIRED on the same task; once the date is updated (or
 * the record deleted) the task closes itself.
 *
 * Newly flagged items go out in one daily summary email to the Health &
 * Safety people, and the person the record is about gets their own email (if
 * their account is linked to the employee or subcontractor and verified).
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

async function namesById(Model, ids, field) {
  const out = new Map();
  if (!Model || !ids.length) return out;
  for (const d of await Model.find({ _id: { $in: ids } }).select(field).lean()) out.set(String(d._id), d);
  return out;
}

const uniq = (records, key) => [...new Set(records.filter((r) => r[key]).map((r) => String(r[key])))];

async function loadNames(records) {
  const [employees, suppliers, contracts] = await Promise.all([
    namesById(mdb.INTERNAL?.employee, uniq(records, 'employeeId'), 'name'),
    namesById(mdb.REST?.supplier, uniq(records, 'subcontractorId'), 'Name'),
    namesById(mdb.INTERNAL?.contract, uniq(records, 'contractId'), 'title siteManagers'),
  ]);
  return { employees, suppliers, contracts };
}

function holderName(rec, names) {
  const base = rec.employeeId
    ? names.employees.get(String(rec.employeeId))?.name
    : names.suppliers.get(String(rec.subcontractorId))?.Name;
  if (rec.personName) return base ? `${rec.personName} (${base})` : rec.personName;
  return base || 'Unknown person';
}

// What each record type is called, and who else hears about it.
const SOURCES = [
  {
    model: 'trainingRecord',
    prefix: 'training:',
    label: (rec) => (rec.title ? `${rec.type} (${rec.title})` : rec.type),
    holderLine: (what, dateStr, expired) => `Your ${what} ${expired ? 'expired' : 'expires'} on ${dateStr}. Please arrange to renew it and send the new card or certificate to the office.`,
    holderSubject: (what, expired) => `Your ${what} ${expired ? 'has expired' : 'is about to expire'}`,
    extraUserIds: () => [],
    advice: 'Renew it and update the training record',
  },
  {
    model: 'induction',
    prefix: 'induction:',
    label: (rec, names) => {
      const site = names.contracts.get(String(rec.contractId))?.title;
      return site ? `Site induction (${site})` : 'Site induction';
    },
    holderLine: (what, dateStr, expired) => `Your ${what} ${expired ? 'was due again on' : 'is due again on'} ${dateStr}. You will be re-inducted before your next day on that site.`,
    holderSubject: (what, expired) => `Your ${what} ${expired ? 'is overdue' : 'is due again soon'}`,
    extraUserIds: (rec, names) => names.contracts.get(String(rec.contractId))?.siteManagers || [],
    advice: 'Re-induct them and record the new induction',
  },
  {
    model: 'rams',
    prefix: 'rams:',
    field: 'reviewDate',
    where: { status: 'Approved' },
    label: (rec) => `RAMS review: ${rec.title}${rec.version ? ` v${rec.version}` : ''}`,
    who: (rec, names) => names.contracts.get(String(rec.contractId))?.title || 'Unknown site',
    holder: false,
    extraUserIds: (rec, names) => names.contracts.get(String(rec.contractId))?.siteManagers || [],
    advice: 'Review the RAMS, issue a new version if the work has changed, and update the review date',
  },
];

/** The holder's own account, when it is linked and can receive email. */
async function holderUser(User, rec) {
  // A named operative of a subcontractor firm is not the firm's account holder.
  if (!rec.employeeId && rec.personName) return null;
  const q = rec.employeeId ? { employeeId: rec.employeeId } : { subcontractorId: rec.subcontractorId };
  return User.findOne({ ...q, email: { $nin: [null, ''] }, emailVerified: true }).select('_id email').lean();
}

async function notifyHolder(User, source, rec, { what, dateStr, isExpired }) {
  if (source.holder === false) return;
  try {
    const user = await holderUser(User, rec);
    if (!user) return;
    const line = source.holderLine(what, dateStr, isExpired);
    await notificationService.enqueue({
      to: user.email,
      recipientUserId: user._id,
      subject: source.holderSubject(what, isExpired),
      html: notificationService.wrapTemplate({ heading: 'Health & Safety', bodyLines: [line] }),
      text: line,
      category: 'health-safety',
      dedupeKey: `${source.prefix}holder-${rec._id}:${dateStr}:${isExpired ? 'expired' : 'expiring'}`,
    });
  } catch (err) {
    logger.error(`[healthSafetyComplianceService] Failed to email the person on ${rec.uuid}: ${err.message}`);
  }
}

async function scanSource(source, { User, userIds, now, horizon, stats, newAlerts }) {
  const Model = mdb.INTERNAL?.[source.model];
  if (!Model) return;
  const errorsBefore = stats.errors;
  const currentKeys = new Set();
  const field = source.field || 'expiryDate';
  const records = await Model.find({ ...(source.where || {}), [field]: { $ne: null, $lte: horizon } }).lean();
  const names = await loadNames(records);

  for (const rec of records) {
    const date = new Date(rec[field]);
    const isExpired = date < now;
    const daysLeft = Math.ceil((date - now) / DAY_MS);
    const dateStr = date.toISOString().slice(0, 10);
    const systemKey = `${source.prefix}${rec._id}:${dateStr}`;
    currentKeys.add(systemKey);

    const who = source.who ? source.who(rec, names) : holderName(rec, names);
    const what = source.label(rec, names);
    const subject = `${what} – ${who}`;
    const title = `[${isExpired ? 'EXPIRED' : 'EXPIRING'}] ${subject}`;
    const description = `${who}: ${what} ${isExpired ? 'expired' : 'expires'} on ${dateStr}. ${source.advice}; this task closes itself once the date is updated.`;
    const suffix = isExpired ? `expired ${Math.abs(daysLeft)} day(s) ago` : `expires in ${daysLeft} day(s)`;
    const recipients = [...new Map([...userIds, ...source.extraUserIds(rec, names)].map((id) => [String(id), id])).values()];

    try {
      const r = await taskService.ensureSystemTask({
        systemKey,
        title,
        legacyTitles: [`[EXPIRED] ${subject}`, `[EXPIRING] ${subject}`],
        description,
        dueDate: date,
        priority: isExpired ? 'high' : 'normal',
        userIds: recipients,
      });
      stats.created += r.created;
      stats.skipped += r.skipped;
      if (r.created > 0 || r.updated > 0) {
        newAlerts.push(`${who} — ${what} ${suffix}`);
        await notifyHolder(User, source, rec, { what, dateStr, isExpired });
      }
    } catch (err) {
      logger.error(`[healthSafetyComplianceService] Failed to create task for ${rec.uuid}: ${err.message}`);
      stats.errors++;
    }
  }

  // Only a complete scan of this source can say a reminder no longer applies.
  if (stats.errors === errorsBefore) {
    try {
      stats.resolved += (await taskService.resolveStaleSystemTasks(source.prefix, currentKeys)) || 0;
    } catch (err) {
      logger.error(`[healthSafetyComplianceService] Failed to close resolved tasks: ${err.message}`);
    }
  }
}

async function checkExpiriesAndCreateTasks({ daysAhead = DEFAULT_DAYS_AHEAD, now = new Date() } = {}) {
  const stats = { created: 0, skipped: 0, errors: 0, resolved: 0 };
  const newAlerts = [];

  const User = mdb.INTERNAL?.user;
  if (!User || !SOURCES.some((s) => mdb.INTERNAL?.[s.model])) {
    logger.warn('[healthSafetyComplianceService] Health & Safety or User models not available — skipping.');
    return stats;
  }

  const people = await healthSafetyUsers(User);
  if (!people.length) {
    logger.warn('[healthSafetyComplianceService] Nobody looks after Health & Safety — cannot create tasks.');
    return stats;
  }
  const ctx = { User, userIds: people.map((u) => u._id), now, horizon: new Date(now.getTime() + daysAhead * DAY_MS), stats, newAlerts };
  for (const source of SOURCES) {
    try {
      await scanSource(source, ctx);
    } catch (err) {
      logger.error(`[healthSafetyComplianceService] ${source.model} scan failed: ${err.message}`);
      stats.errors++;
    }
  }

  if (newAlerts.length > 0) {
    const today = now.toISOString().slice(0, 10);
    const html = notificationService.wrapTemplate({
      heading: 'Health & Safety',
      bodyLines: [`These have expired or are due within ${daysAhead} days:`, ...newAlerts],
      ctaText: 'Open Health & Safety',
      ctaUrl: `${notificationService.baseUrl()}/overview/healthSafety`,
    });
    const text = ['Health & Safety items expired or due soon:', ...newAlerts].join('\n');
    for (const u of people) {
      if (!u.email || !u.emailVerified) continue;
      try {
        await notificationService.enqueue({
          to: u.email,
          recipientUserId: u._id,
          subject: `Health & Safety: ${newAlerts.length} item(s) need attention`,
          html, text,
          category: 'health-safety',
          dedupeKey: `health-safety-expiry-${today}:${u.email}`,
        });
      } catch (err) {
        logger.error(`[healthSafetyComplianceService] Failed to queue summary email: ${err.message}`);
      }
    }
  }

  if (stats.created > 0 || stats.errors > 0 || stats.resolved > 0) {
    logger.info(`[healthSafetyComplianceService] Check complete: ${stats.created} tasks created, ${stats.skipped} skipped, ${stats.resolved} closed, ${stats.errors} errors.`);
  }
  return stats;
}

export default {
  checkExpiriesAndCreateTasks,
  healthSafetyJobRoles,
};
