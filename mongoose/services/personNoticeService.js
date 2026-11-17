/**
 * personNoticeService — tell employees and subcontractors about things that
 * affect them, through notifyService.notifyUsers.
 *
 * Only the users linked to the person concerned (user.employeeId /
 * user.subcontractorId) are told, and a person gets one notice per action:
 *
 *   attendance (type 'attendance')
 *     sheetSaved      days planned or changed on the weekly sheet
 *     importedDays    days written by the weekly sheet import
 *     attendanceDecided  days given final approval, rejected, or marked not attended
 *   payroll (type 'payroll', employees only)
 *     payrollRunChanged  a run locked (pay settled), or an entry in a locked
 *                        run changed after that (pay updated)
 *   policies (type 'policy-update')
 *     policyPublished    a policy published, or a published one given a new
 *                        version (or a new owner)
 *
 * The user who made the change isn't told about it (`actorId`). Every
 * dedupeKey is stable for the thing it describes, so a retry or a repeat of
 * the same thing queues nothing new.
 *
 * Nothing here throws: a failure is logged and the save, approval, lock or
 * publish it hangs off carries on.
 */
import crypto from 'crypto';
import mdb from './mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import notifyService from '../../services/notifyService.js';
import { resolvePayrollWeek } from './attendanceService.js';

const USER_FIELDS = '_id email phoneNumber employeeId subcontractorId';
const MAX_LINES = 14;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const str = (v) => (v == null ? null : String(v._id || v));
const noon = (key) => new Date(`${key}T12:00:00Z`);

/** Short stable hash of a list of strings. */
export function hashOf(parts) {
  return crypto.createHash('sha1').update(parts.map(String).join('\n')).digest('hex').slice(0, 16);
}

/** 'e:<id>' for an employee, 's:<id>' for a subcontractor. */
export function personKeyOf(rec) {
  if (rec?.employeeId) return `e:${str(rec.employeeId)}`;
  if (rec?.subcontractorId) return `s:${str(rec.subcontractorId)}`;
  return null;
}

/** "Mon 23 Nov" for a yyyy-MM-dd day key. */
export function dayLabel(key) {
  const d = noon(key);
  if (Number.isNaN(d.getTime())) return String(key);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "d MMM yyyy" for a date, in London. */
function dateLabel(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
}

/** yyyy-MM-dd of a stored attendance date (saved at local midnight). */
export function dayKeyOf(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The person's weekly attendance page for the payroll week holding `key`:
 * /weekly/<tax year>/<week>. Falls back to /weekly (this week).
 */
export function weeklyLinkFor(key) {
  try {
    const target = noon(key);
    if (Number.isNaN(target.getTime())) return '/weekly';
    const y = target.getUTCFullYear();
    for (const year of [y, y - 1]) {
      const first = resolvePayrollWeek(year, 1).payrollWeekStart;
      const n = Math.floor((target.getTime() - first.getTime()) / (7 * 864e5)) + 1;
      if (n < 1) continue;
      const week = resolvePayrollWeek(year, n);
      if (week.week === n && week.days.includes(key)) return `/weekly/${year}/${n}`;
    }
  } catch (err) {
    logger.warn(`[personNotice] no weekly link for ${key}: ${err.message}`);
  }
  return '/weekly';
}

/** Up to MAX_LINES lines, then "and N more". */
function capLines(lines) {
  if (lines.length <= MAX_LINES) return lines;
  const more = lines.length - MAX_LINES;
  return [...lines.slice(0, MAX_LINES), `and ${more} more ${more === 1 ? 'day' : 'days'}`];
}

/**
 * Users linked to these people, by person key, leaving out `actorId`.
 * @returns {Promise<Map<string, object[]>>}
 */
export async function usersByPerson(personKeys, { actorId = null, db = mdb } = {}) {
  const User = db?.INTERNAL?.user;
  const out = new Map();
  if (!User || !personKeys.length) return out;
  const employeeIds = [];
  const subcontractorIds = [];
  for (const k of personKeys) {
    if (k.startsWith('e:')) employeeIds.push(k.slice(2));
    else if (k.startsWith('s:')) subcontractorIds.push(k.slice(2));
  }
  const or = [];
  if (employeeIds.length) or.push({ employeeId: { $in: employeeIds } });
  if (subcontractorIds.length) or.push({ subcontractorId: { $in: subcontractorIds } });
  if (!or.length) return out;
  const users = await User.find({ $or: or }).select(USER_FIELDS).lean();
  const wanted = new Set(personKeys);
  for (const u of users || []) {
    if (actorId && String(u._id) === String(actorId)) continue;
    for (const key of [u.employeeId ? `e:${str(u.employeeId)}` : null, u.subcontractorId ? `s:${str(u.subcontractorId)}` : null]) {
      if (!key || !wanted.has(key)) continue;
      (out.get(key) || out.set(key, []).get(key)).push(u);
    }
  }
  return out;
}

/** notifyUsers for one person; logs and swallows any failure. */
async function send(users, notice) {
  if (!users?.length) return null;
  try {
    return await notifyService.notifyUsers({ users, ...notice });
  } catch (err) {
    logger.error(`[personNotice] "${notice.type}" ${notice.dedupeKey || ''} failed: ${err.message}`);
    return null;
  }
}

/** Runs `fn`, logging instead of throwing. */
async function safely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`[personNotice] ${label} failed: ${err.message}`);
    return null;
  }
}

// ── Attendance ──────────────────────────────────────────────────────────

/**
 * The weekly sheet saved some days. One notice per person listing their
 * changed days. changes: [{ key, day, beforeLabel, afterLabel, stamp }] where
 * `stamp` makes the change unique (the record id and its prior updatedAt),
 * so the same save repeated adds nothing but a later identical change does.
 */
export async function sheetSaved({ monday, changes = [], actorId = null, db = mdb } = {}) {
  return safely('sheetSaved', async () => {
    const byPerson = new Map();
    for (const c of changes) (byPerson.get(c.key) || byPerson.set(c.key, []).get(c.key)).push(c);
    if (!byPerson.size) return 0;
    const users = await usersByPerson([...byPerson.keys()], { actorId, db });
    let sent = 0;
    for (const [key, list] of byPerson) {
      if (!users.get(key)?.length) continue;
      list.sort((a, b) => a.day.localeCompare(b.day));
      const lines = list.map((c) => {
        const before = c.beforeLabel || '';
        const after = c.afterLabel || '';
        if (!before) return `${dayLabel(c.day)}: ${after}`;
        if (!after) return `${dayLabel(c.day)}: ${before} → removed`;
        return `${dayLabel(c.day)}: ${before} → ${after}`;
      });
      const n = list.length;
      const res = await send(users.get(key), {
        type: 'attendance',
        subject: `Your week of ${dayLabel(monday)}: ${n} ${n === 1 ? 'day' : 'days'} planned or changed`,
        text: `These days on your weekly attendance were planned or changed:\n\n${capLines(lines).join('\n')}`,
        smsText: `Your attendance for the week of ${dayLabel(monday)} has changed (${n} ${n === 1 ? 'day' : 'days'}). Check it in the app.`,
        link: weeklyLinkFor(list[0].day),
        dedupeKey: `attendance:sheet:${monday}:${hashOf(list.map((c) => `${c.day}|${c.beforeLabel}>${c.afterLabel}|${c.stamp || ''}`))}:${key}`,
        refType: 'attendance',
      });
      if (res) sent++;
    }
    return sent;
  });
}

/**
 * The weekly sheet import wrote days. One notice per person per import.
 * days: [{ key, day, label, stamp }] (stamp: the new record's id).
 */
export async function importedDays({ uploadId, days = [], actorId = null, db = mdb } = {}) {
  return safely('importedDays', async () => {
    const byPerson = new Map();
    for (const d of days) (byPerson.get(d.key) || byPerson.set(d.key, []).get(d.key)).push(d);
    if (!byPerson.size) return 0;
    const users = await usersByPerson([...byPerson.keys()], { actorId, db });
    let sent = 0;
    for (const [key, list] of byPerson) {
      if (!users.get(key)?.length) continue;
      list.sort((a, b) => a.day.localeCompare(b.day));
      const n = list.length;
      const res = await send(users.get(key), {
        type: 'attendance',
        subject: `${n} ${n === 1 ? 'day' : 'days'} of your attendance recorded from the weekly sheet`,
        text: `These days were recorded for you from the weekly attendance sheet. Check them before they're approved:\n\n${capLines(list.map((d) => `${dayLabel(d.day)}: ${d.label}`)).join('\n')}`,
        smsText: `${n} ${n === 1 ? 'day' : 'days'} of your attendance were recorded from the weekly sheet. Check them in the app.`,
        link: weeklyLinkFor(list[0].day),
        // An import retried after failures writes other days: those are told too
        dedupeKey: `attendance:import:${uploadId}:${hashOf(list.map((d) => `${d.day}|${d.stamp || ''}`))}:${key}`,
        refType: 'attendance',
      });
      if (res) sent++;
    }
    return sent;
  });
}

const DECISIONS = {
  approved: { verb: 'approved', title: 'approved' },
  rejected: { verb: 'rejected', title: 'rejected' },
  'not-attended': { verb: 'marked not attended (now Off, waiting for sign-off)', title: 'marked not attended' },
};

/**
 * Days given a decision by someone else: one notice per person.
 * action: 'approved' | 'rejected' | 'not-attended'. records: the updated
 * attendance records. The rejection reason comes from the records.
 */
export async function attendanceDecided({ action, records = [], actorId = null, db = mdb } = {}) {
  return safely(`attendanceDecided(${action})`, async () => {
    const decision = DECISIONS[action];
    if (!decision) return 0;
    const byPerson = new Map();
    for (const r of records) {
      const key = personKeyOf(r);
      if (key) (byPerson.get(key) || byPerson.set(key, []).get(key)).push(r);
    }
    if (!byPerson.size) return 0;
    const users = await usersByPerson([...byPerson.keys()], { actorId, db });
    let sent = 0;
    for (const [key, list] of byPerson) {
      if (!users.get(key)?.length) continue;
      const days = list.map((r) => ({ r, day: dayKeyOf(r.date) })).sort((a, b) => a.day.localeCompare(b.day));
      const reasons = [...new Set(list.map((r) => (r.rejectionReason || '').trim()).filter(Boolean))];
      const n = days.length;
      const what = n === 1 ? dayLabel(days[0].day) : `${n} days`;
      const lines = capLines(days.map(({ day }) => dayLabel(day)));
      const parts = [`These days on your attendance were ${decision.verb}:\n\n${lines.join('\n')}`];
      if (action === 'rejected' && reasons.length) parts.push(`Reason: ${reasons.join('; ')}`);
      if (action === 'rejected') parts.push('Check them and talk to your manager if something is wrong.');
      const stamp = days.map(({ r }) => `${str(r._id)}|${new Date(r.rejectedAt || r.approvedAt || r.updatedAt || 0).getTime()}`);
      const res = await send(users.get(key), {
        type: 'attendance',
        subject: `Attendance ${decision.title}: ${what}`,
        text: parts.join('\n\n'),
        smsText: `Your attendance for ${what} was ${decision.title}${action === 'rejected' && reasons.length ? `: ${reasons.join('; ')}` : ''}. Check it in the app.`,
        link: weeklyLinkFor(days[0].day),
        dedupeKey: `attendance:${action}:${hashOf(stamp)}:${key}`,
        refType: 'attendance',
        refId: n === 1 ? list[0]._id : null,
      });
      if (res) sent++;
    }
    return sent;
  });
}

// ── Payroll ─────────────────────────────────────────────────────────────

const FINGERPRINT_FIELDS = [
  'grossPay', 'taxDeducted', 'employeeNI', 'employeePension',
  'studentLoanDeduction', 'postgradLoanDeduction', 'netPay',
];

/** What an employee's pay looks like to them: changes when any figure or the payment date does. */
export function entryFingerprint(entry) {
  const parts = FINGERPRINT_FIELDS.map((f) => (entry?.[f] == null ? '' : String(entry[f])));
  parts.push(entry?.paymentDate ? new Date(entry.paymentDate).toISOString() : '');
  return hashOf(parts);
}

/** "tax week 33, 2026/27 (14 Nov 2026 to 20 Nov 2026)". */
export function periodLabel(run) {
  const which = run.taxWeek ? `tax week ${run.taxWeek}` : run.taxMonth ? `tax month ${run.taxMonth}` : 'the pay period';
  const dates = run.periodStart && run.periodEnd ? ` (${dateLabel(run.periodStart)} to ${dateLabel(run.periodEnd)})` : '';
  return `${which}, ${run.taxYear}${dates}`;
}

/**
 * Tell each employee in a locked run about their pay: "settled" the first
 * time the run is locked with their entry, "updated" when their entry has
 * changed since they were last told (re-run or amended while locked, or
 * changed while unlocked and locked again). Nothing for a draft or
 * submitted run. Each entry remembers what it was last told
 * (payrollEntry.noticeFingerprint). No amounts: there's no payslip page
 * for employees yet, so the notice gives the period and payment date only.
 */
export async function payrollRunChanged(runId, { db = mdb } = {}) {
  return safely(`payrollRunChanged(${runId})`, async () => {
    const PayrollRun = db?.INTERNAL?.payrollRun;
    const PayrollEntry = db?.INTERNAL?.payrollEntry;
    if (!PayrollRun || !PayrollEntry || !runId) return 0;
    const run = await PayrollRun.findOne({ _id: runId }).lean();
    if (!run || run.status !== 'locked') return 0;
    const entries = await PayrollEntry.find({ runId: run._id })
      .select(`_id employeeId paymentDate noticeFingerprint ${FINGERPRINT_FIELDS.join(' ')}`).lean();
    const pending = entries
      .map((e) => ({ e, fp: entryFingerprint(e) }))
      .filter(({ e, fp }) => e.employeeId && e.noticeFingerprint !== fp);
    if (!pending.length) return 0;
    const users = await usersByPerson([...new Set(pending.map(({ e }) => `e:${str(e.employeeId)}`))], { db });
    const period = periodLabel(run);
    const paid = run.paymentDate ? dateLabel(run.paymentDate) : null;
    let sent = 0;
    for (const { e, fp } of pending) {
      const key = `e:${str(e.employeeId)}`;
      const updated = !!e.noticeFingerprint;
      const people = users.get(key) || [];
      if (people.length) {
        const res = await send(people, updated
          ? {
              type: 'payroll',
              subject: 'Your pay has been updated',
              text: `Your pay for ${period} was changed after it was settled.${paid ? ` Payment date: ${paid}.` : ''} Ask the office if you have questions.`,
              smsText: 'Your pay has been updated. Ask the office if you have questions.',
              dedupeKey: `payroll:${run._id}:updated:${str(e.employeeId)}:${fp}`,
              refType: 'payrollEntry', refId: e._id,
            }
          : {
              type: 'payroll',
              subject: 'Your pay is settled',
              text: `Your pay for ${period} has been settled.${paid ? ` Payment date: ${paid}.` : ''}`,
              smsText: `Your pay is settled.${paid ? ` Payment date: ${paid}.` : ''}`,
              dedupeKey: `payroll:${run._id}:locked:${str(e.employeeId)}`,
              refType: 'payrollEntry', refId: e._id,
            });
        if (!res) continue; // failed: try again next time
        sent++;
      }
      await PayrollEntry.updateOne({ _id: e._id }, { $set: { noticeFingerprint: fp } });
    }
    return sent;
  });
}

// ── Policy documents ────────────────────────────────────────────────────

/**
 * Whether saving a policy should tell people: it's published now and was
 * not before, or its version or owner changed while published. Pure.
 */
export function policyNeedsNotice(before, after) {
  if (!after?.isPublished) return false;
  if (!before || !before.isPublished) return true;
  return String(before.version || '') !== String(after.version || '')
    || str(before.employee) !== str(after.employee);
}

/**
 * A policy published or given a new version: an individual document
 * (employee set) goes to that employee's users, linked to the document; a
 * company policy goes to every user linked to an active employee. Company
 * policies aren't shown to employees or subcontractors in the app (Company
 * Docs needs Documents view), so that notice has no link and subcontractors
 * aren't told.
 */
export async function policyPublished(policy, { actorId = null, db = mdb } = {}) {
  return safely(`policyPublished(${policy?.uuid})`, async () => {
    if (!policy?.isPublished || !policy.uuid) return 0;
    let keys;
    if (policy.employee) {
      keys = [`e:${str(policy.employee)}`];
    } else {
      const Employee = db?.INTERNAL?.employee;
      if (!Employee) return 0;
      const active = await Employee.find({ status: 'active' }).select('_id').lean();
      keys = active.map((e) => `e:${str(e)}`);
    }
    const byPerson = await usersByPerson(keys, { actorId, db });
    const seen = new Set();
    const users = [...byPerson.values()].flat().filter((u) => !seen.has(String(u._id)) && seen.add(String(u._id)));
    if (!users.length) return 0;
    const version = policy.version || '1.0';
    const individual = !!policy.employee;
    const res = await send(users, {
      type: 'policy-update',
      subject: individual ? `Your document: ${policy.title}` : `Policy published: ${policy.title}`,
      text: individual
        ? `${policy.title} (version ${version}) is ready for you to read.`
        : `${policy.title} (version ${version}) has been published. Please read it and ask the office if you need a copy.`,
      smsText: individual
        ? `${policy.title} (version ${version}) is ready for you to read in the app.`
        : `${policy.title} (version ${version}) has been published. Ask the office for a copy.`,
      link: individual ? `/company-docs/policies/${policy.uuid}/print` : null,
      // notifyUsers adds the channel and user, so a new owner is still told
      dedupeKey: `policy:${policy.uuid}:${version}`,
      refType: 'policyDocument', refId: policy._id || null,
    });
    return res ? users.length : 0;
  });
}

export default {
  hashOf, personKeyOf, dayLabel, dayKeyOf, weeklyLinkFor, usersByPerson, entryFingerprint, periodLabel,
  sheetSaved, importedDays, attendanceDecided, payrollRunChanged, policyNeedsNotice, policyPublished,
};
