'use strict';

const mdb = require('../mongoose/services/mongooseDatabaseService');
const emailService = require('./emailService');
const logger = require('./loggerService');

/**
 * Central notification service (email outbox).
 *
 * Usage from any feature:
 *   await notificationService.enqueue({
 *     to, subject,
 *     html: notificationService.wrapTemplate({ heading, bodyLines, ctaText, ctaUrl }),
 *     text, category: 'holiday', refType: 'employeeHoliday', refId: doc._id,
 *     dedupeKey: 'holiday-approved-' + doc._id,   // optional idempotency
 *   });
 *
 * Delivery happens asynchronously via the 'notification-outbox' job with
 * exponential backoff (5 attempts), so callers never block on SMTP and a
 * mail outage cannot lose messages.
 */

const BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 min, doubles per attempt
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000; // cap at 6 h

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Branded HTML wrapper matching the existing verification/reset emails.
 * `bodyLines` are escaped; pass `bodyHtml` instead to supply raw HTML.
 */
function wrapTemplate({ heading, bodyLines = [], bodyHtml = '', ctaText, ctaUrl }) {
  const paragraphs = bodyHtml ||
    bodyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n      ');
  const cta = ctaText && ctaUrl
    ? `<p style="text-align: center; margin: 30px 0;">
        <a href="${escapeHtml(ctaUrl)}"
           style="background-color: #15803d; color: #fff; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-size: 16px;">
          ${escapeHtml(ctaText)}
        </a>
      </p>`
    : '';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #15803d;">${escapeHtml(heading)}</h2>
      ${paragraphs}
      ${cta}
      <p style="color: #999; font-size: 12px;">This is an automated message from the Heron CS platform.</p>
    </div>
  `;
}

function baseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

/**
 * Queue a notification. Returns the created doc, or null when skipped
 * (deduplicated or recipient missing).
 */
async function enqueue({ to, subject, html, text, category = 'system', refType = null, refId = null, dedupeKey = null }) {
  const Notification = mdb.INTERNAL?.notification;
  if (!Notification) {
    logger.warn('[notificationService] Notification model unavailable — dropping: ' + subject);
    return null;
  }
  if (!to) {
    logger.warn(`[notificationService] No recipient for "${subject}" (${category}) — skipped`);
    return null;
  }
  if (dedupeKey) {
    const existing = await Notification.findOne({ dedupeKey }).select('_id').lean();
    if (existing) return null;
  }
  const doc = await Notification.create({
    to, subject, html, text, category, refType,
    refId: refId != null ? String(refId) : null,
    dedupeKey,
  });
  return doc;
}

/**
 * Queue the same notification to every user holding one of `roles`
 * (verified email required). Dedupe is applied per recipient.
 */
async function enqueueForRoles(roles, { subject, html, text, category, refType, refId, dedupeKey }) {
  const User = mdb.INTERNAL?.user;
  if (!User) return { queued: 0 };
  const users = await User.find({
    role: { $in: roles },
    email: { $nin: [null, ''] },
    emailVerified: true,
  }).select('email').lean();

  let queued = 0;
  for (const u of users) {
    const doc = await enqueue({
      to: u.email, subject, html, text, category, refType, refId,
      dedupeKey: dedupeKey ? `${dedupeKey}:${u.email}` : null,
    });
    if (doc) queued++;
  }
  return { queued, recipients: users.length };
}

/** Deliver due pending notifications. Runs as the 'notification-outbox' job. */
async function processOutbox({ batchSize = 20 } = {}) {
  const Notification = mdb.INTERNAL?.notification;
  if (!Notification) return { sent: 0, failed: 0 };

  const now = new Date();
  const due = await Notification.find({
    status: 'pending',
    nextAttemptAt: { $lte: now },
  }).sort({ nextAttemptAt: 1 }).limit(batchSize);

  const stats = { sent: 0, retried: 0, failed: 0 };
  for (const doc of due) {
    try {
      await emailService.sendMail({
        to: doc.to,
        subject: doc.subject,
        html: doc.html,
        text: doc.text,
      });
      doc.status = 'sent';
      doc.sentAt = new Date();
      doc.attempts += 1;
      doc.lastError = null;
      stats.sent++;
    } catch (err) {
      doc.attempts += 1;
      doc.lastError = (err.message || String(err)).slice(0, 500);
      if (doc.attempts >= doc.maxAttempts) {
        doc.status = 'failed';
        stats.failed++;
        logger.error(`[notificationService] Giving up on "${doc.subject}" to ${doc.to} after ${doc.attempts} attempts: ${doc.lastError}`);
      } else {
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (doc.attempts - 1), BACKOFF_MAX_MS);
        doc.nextAttemptAt = new Date(Date.now() + backoff);
        stats.retried++;
      }
    }
    await doc.save();
  }
  return stats;
}

module.exports = {
  enqueue,
  enqueueForRoles,
  processOutbox,
  wrapTemplate,
  baseUrl,
};
