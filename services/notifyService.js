/**
 * notifyService — tell people something, on the channels they chose.
 *
 * ONE ENTRY POINT for person-facing notices (weekly attendance, payroll,
 * policy documents, …):
 *
 *   import notifyService from '../../services/notifyService.js';
 *
 *   const result = await notifyService.notifyUsers({
 *     userIds: [user._id],          // or users: [{ _id, email, phoneNumber }]
 *     type: 'attendance',           // emailType key: 'attendance' | 'payroll' | 'policy-update' | …
 *     subject: 'Your attendance for w/c 9 November',
 *     text: 'You worked 38.5 hours. Check it before Friday.',   // plain text (email + in-app body)
 *     html: '<p>…</p>',             // optional email body fragment; default is built from subject/text/link
 *     smsText: 'Attendance for w/c 9 Nov: 38.5h. Check it in the app.', // optional; default from subject/text
 *     link: '/attendance/mine?week=2026-11-09',  // optional same-site path
 *     dedupeKey: 'attendance:2026-11-09',        // optional; made per user and channel
 *     refType: 'attendance', refId: weekId,       // optional, recorded on outbox rows
 *   });
 *   // → { recipients, email, sms, inApp, skipped }  (counts of what was queued/stored)
 *
 * For each person it resolves the channels with
 * emailPreferenceService.resolveChannels (type defaults, their saved choice
 * per channel, unsubscribable types always on, SMS only with a phone number)
 * and then:
 *   - email  → notificationService.enqueue (outbox, retry/backoff, footer,
 *              branding, its own unsubscribe gating);
 *   - sms    → notificationService.enqueueSms (same outbox and retry, sent
 *              by smsService; log-only when Twilio is not configured);
 *   - inApp  → inAppNotificationService.create (shown at /notifications).
 *
 * `dedupeKey` is suffixed with ':<channel>:<userId>', so calling twice with
 * the same key queues nothing new, while each person and channel is still
 * tracked on its own. An unknown `type` is auto-registered DISABLED (see
 * emailTypeService.resolveOrRegister) and sends nothing until an admin enables
 * it. A disabled type sends nothing.
 */

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import logger from './loggerService.js';
import notificationService from './notificationService.js';
import emailTypeService from '../mongoose/services/emailTypeService.js';
import emailPreferenceService from '../mongoose/services/emailPreferenceService.js';
import inAppNotificationService from '../mongoose/services/inAppNotificationService.js';

const USER_FIELDS = '_id email phoneNumber';

async function loadUsers({ users, userIds }) {
  if (Array.isArray(users) && users.length) return users.filter((u) => u && u._id);
  if (!Array.isArray(userIds) || !userIds.length) return [];
  const User = mdb.INTERNAL?.user;
  if (!User) return [];
  return User.find({ _id: { $in: userIds } }).select(USER_FIELDS).lean();
}

async function loadPrefs(userIds, typeKey) {
  const EmailPreference = mdb.INTERNAL?.emailPreference;
  if (!EmailPreference || !userIds.length) return new Map();
  const rows = await EmailPreference.find({ userId: { $in: userIds.map(String) }, typeKey })
    .select('userId subscribed sms inApp').lean();
  return new Map(rows.map((r) => [String(r.userId), r]));
}

function absoluteUrl(link) {
  const safe = inAppNotificationService.safeLink(link);
  return safe ? `${notificationService.baseUrl()}${safe}` : null;
}

/** Default SMS: "Subject: text" plus the link, trimmed by enqueueSms. */
function defaultSmsText({ subject, text, url }) {
  const main = [subject, text].filter(Boolean).join(': ').replace(/\s+/g, ' ').trim();
  return url ? `${main} ${url}` : main;
}

function perChannelKey(dedupeKey, channel, userId) {
  return dedupeKey ? `${dedupeKey}:${channel}:${userId}` : null;
}

/**
 * Notify people of one notice on each channel they get for `type`.
 * See the file header for the parameters. Never throws for one bad recipient:
 * a failure is logged and counted in `skipped`.
 */
async function notifyUsers({
  users, userIds, type, subject, text = '', html = null, smsText = null,
  link = null, dedupeKey = null, refType = null, refId = null,
} = {}) {
  const result = { recipients: 0, email: 0, sms: 0, inApp: 0, skipped: 0 };
  if (!type || !subject) {
    logger.warn('[notifyService] notifyUsers needs a type and a subject — nothing sent');
    return result;
  }
  const typeKey = String(type).toLowerCase();
  const typeDoc = await emailTypeService.resolveOrRegister(typeKey);
  const people = await loadUsers({ users, userIds });
  result.recipients = people.length;
  if (!typeDoc || typeDoc.enabled === false || !people.length) {
    result.skipped = people.length;
    return result;
  }

  const prefs = await loadPrefs(people.map((u) => u._id), typeKey);
  const url = absoluteUrl(link);
  const emailHtml = html != null
    ? html
    : notificationService.wrapTemplate({
        heading: subject,
        bodyLines: String(text || '').split(/\n{2,}/).map((l) => l.trim()).filter(Boolean),
        ...(url ? { ctaText: 'Open', ctaUrl: url } : {}),
      });
  const emailText = url ? `${text}\n\n${url}` : text;
  const sms = smsText || defaultSmsText({ subject, text, url });

  for (const user of people) {
    const userId = String(user._id);
    const channels = emailPreferenceService.resolveChannels({ type: typeDoc, pref: prefs.get(userId) || null, user });
    let any = false;
    try {
      if (channels.email) {
        const doc = await notificationService.enqueue({
          to: user.email, subject, html: emailHtml, text: emailText,
          typeKey, senderType: 'system', recipientUserId: user._id,
          refType, refId, dedupeKey: perChannelKey(dedupeKey, 'email', userId),
        });
        if (doc) { result.email++; any = true; }
      }
      if (channels.sms) {
        const doc = await notificationService.enqueueSms({
          to: user.phoneNumber, text: sms, subject,
          typeKey, recipientUserId: user._id,
          refType, refId, dedupeKey: perChannelKey(dedupeKey, 'sms', userId),
        });
        if (doc) { result.sms++; any = true; }
      }
      if (channels.inApp) {
        const doc = await inAppNotificationService.create({
          userId, typeKey, title: subject, body: text, link,
          dedupeKey: perChannelKey(dedupeKey, 'inApp', userId),
        });
        if (doc) { result.inApp++; any = true; }
      }
    } catch (err) {
      logger.error(`[notifyService] "${typeKey}" to user ${userId} failed: ${err.message}`);
    }
    if (!any) result.skipped++;
  }
  return result;
}

export default { notifyUsers };

export { notifyUsers };
