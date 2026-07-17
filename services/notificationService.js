'use strict';

const mdb = require('../mongoose/services/mongooseDatabaseService');
const emailService = require('./emailService');
const logger = require('./loggerService');
const emailTypeService = require('../mongoose/services/emailTypeService');
const emailPreferenceService = require('../mongoose/services/emailPreferenceService');
const emailBrandingService = require('../mongoose/services/emailBrandingService');
const unsubscribeTokenService = require('../mongoose/services/unsubscribeTokenService');

/**
 * Central notification service (email outbox).
 *
 * Usage from any feature:
 *   await notificationService.enqueue({
 *     to, subject,
 *     html: notificationService.wrapTemplate({ heading, bodyLines, ctaText, ctaUrl }),
 *     text, typeKey: 'task-assigned', senderType: 'system',
 *     recipientUserId: user._id, refType: 'task', refId: doc._id,
 *     dedupeKey: 'task-assigned:' + doc.uuid,   // optional idempotency
 *   });
 *
 * enqueue() resolves the recipient and the emailType, then GATES the send:
 *   - a disabled type never sends;
 *   - a subscribable type is skipped when the recipient has unsubscribed;
 *   - any admin-originated email is skipped when the recipient turned off
 *     "allow admins to email me".
 * It then appends the correct unsubscribe footer for the recipient before
 * queueing. Delivery happens asynchronously via the 'notification-outbox' job.
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

// Only allow link schemes that are safe inside an email button. Anything else
// (javascript:, data:, etc.) is neutralised to '#'. Relative paths are allowed.
function safeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return '#';
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^\//.test(value)) return value; // app-relative path
  return '#';
}

function renderButton(text, url) {
  return `<a href="${escapeHtml(safeUrl(url))}"
           style="display: inline-block; background-color: #15803d; color: #fff; margin: 6px; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-size: 16px;">
          ${escapeHtml(text)}
        </a>`;
}

/**
 * Branded HTML wrapper matching the existing verification/reset emails.
 * `bodyLines` are escaped; pass `bodyHtml` instead to supply raw HTML.
 *
 * Action buttons: pass a single `ctaText`/`ctaUrl` (legacy) and/or an `actions`
 * array of `{ text|label, url }`. All are rendered together, centred, wrapping
 * across lines when there are several.
 */
function wrapTemplate({ heading, bodyLines = [], bodyHtml = '', ctaText, ctaUrl, actions = [] }) {
  const paragraphs = bodyHtml ||
    bodyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n      ');
  const allActions = [
    ...(ctaText && ctaUrl ? [{ text: ctaText, url: ctaUrl }] : []),
    ...(Array.isArray(actions) ? actions : []),
  ]
    .map((a) => ({ text: a && (a.text || a.label), url: a && a.url }))
    .filter((a) => a.text && a.url);
  const cta = allActions.length
    ? `<div style="text-align: center; margin: 30px 0;">
        ${allActions.map((a) => renderButton(a.text, a.url)).join('\n        ')}
      </div>`
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

/** Crude HTML→text for the plaintext part of branded header/footer blocks. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|tr|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Resolve the branded header/footer blocks that apply to `type`. Each block is
 * included only when it is globally enabled AND the type opts in (both flags
 * default on). Returns { header, footer } HTML strings (possibly empty).
 */
function resolveBranding(branding, type) {
  const out = { header: '', footer: '' };
  if (!branding) return out;
  const wantsHeader = !type || type.useGlobalHeader !== false;
  const wantsFooter = !type || type.useGlobalFooter !== false;
  if (branding.headerEnabled && branding.headerHtml && wantsHeader) out.header = branding.headerHtml;
  if (branding.footerEnabled && branding.footerHtml && wantsFooter) out.footer = branding.footerHtml;
  return out;
}

function baseUrl() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

const DASHBOARD_PATH = '/user/account/settings/notifications';

/**
 * Build the unsubscribe footer (html + text) for one recipient. The link always
 * points at a page — never a URL that mutates on load. Returns the four variants
 * the product spec requires, keyed on senderType + subscribable.
 *
 * `token` is a signed unsubscribe token (see unsubscribeTokenService) whose
 * scope is baked in, so the URL needs no `type`/`admin` query params. When no
 * token is supplied (e.g. previews) the link falls back to the dashboard.
 */
function buildFooter({ senderType = 'system', subscribable = false, typeKey = null, token = null }) {
  const root = baseUrl();
  // Deep-link into the recipient's own dashboard (requires their login).
  const dashUrl = `${root}${DASHBOARD_PATH}${typeKey ? `#type-${encodeURIComponent(typeKey)}` : ''}`;
  // Token-scoped confirmation page (works logged-out; read-only until they click).
  const tokenUnsub = () => token
    ? `${root}/notifications/unsubscribe?token=${encodeURIComponent(token)}`
    : dashUrl;

  let sentence;
  let link;
  let linkText = 'unsubscribe here';

  if (senderType === 'admin' && !subscribable) {
    // Direct email from a human admin — cannot unsubscribe from the message,
    // but may stop admins contacting them at all.
    sentence = 'This email was sent by an administrator. You cannot unsubscribe from it — please contact an administrator, or change your notification settings so administrators can no longer contact you.';
    link = tokenUnsub();
    linkText = 'change your notification settings';
  } else if (senderType === 'admin') {
    sentence = 'This is an admin notification email.';
    link = tokenUnsub();
  } else if (senderType === 'user') {
    sentence = 'This is a user notification email.';
    link = tokenUnsub();
  } else if (!subscribable) {
    // Mandatory system message (e.g. security) — no unsubscribe.
    return {
      html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 16px auto 0; padding-top: 12px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
      <p style="margin: 0;">This is a system notification email. It is required for the operation of your account and cannot be unsubscribed from.</p>
    </div>`,
      text: '\n\n—\nThis is a system notification email. It is required for the operation of your account and cannot be unsubscribed from.',
    };
  } else {
    sentence = 'This is a system notification email.';
    link = tokenUnsub();
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 16px auto 0; padding-top: 12px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
      <p style="margin: 0;">${escapeHtml(sentence)} <a href="${escapeHtml(link)}" style="color: #15803d;">${escapeHtml(linkText)}</a>.</p>
    </div>`;
  const text = `\n\n—\n${sentence} ${linkText}: ${link}`;
  return { html, text };
}

async function resolveRecipientUser(recipientUserId, to) {
  const User = mdb.INTERNAL?.user;
  if (!User) return null;
  try {
    if (recipientUserId && typeof User.findById === 'function') {
      const byId = await User.findById(recipientUserId).lean();
      if (byId) return byId;
    }
    if (to && typeof User.findOne === 'function') {
      return await User.findOne({ email: String(to).toLowerCase() }).lean();
    }
  } catch (_) { /* best-effort — gating/footer degrade gracefully without a user */ }
  return null;
}

/**
 * Queue a notification. Returns the created doc, or null when skipped
 * (deduplicated, recipient missing, type disabled, or recipient unsubscribed).
 */
async function enqueue({
  to, subject, html, text,
  category = 'system', typeKey = null,
  senderType = 'system', senderUserId = null, recipientUserId = null,
  refType = null, refId = null, dedupeKey = null,
}) {
  const Notification = mdb.INTERNAL?.notification;
  if (!Notification) {
    logger.warn('[notificationService] Notification model unavailable — dropping: ' + subject);
    return null;
  }
  if (!to) {
    logger.warn(`[notificationService] No recipient for "${subject}" (${typeKey || category}) — skipped`);
    return null;
  }

  const key = (typeKey || category) || null;
  const type = key ? await emailTypeService.resolveOrRegister(key) : null;
  const user = await resolveRecipientUser(recipientUserId, to);

  // ── Gating ─────────────────────────────────────────────────────────
  if (type && type.enabled === false) {
    logger.info(`[notificationService] Type "${key}" disabled — "${subject}" to ${to} skipped`);
    return null;
  }
  const subscribable = type ? type.subscribable : false;
  // Any admin-originated email respects the recipient's master switch.
  if (senderType === 'admin' && user && user.allowAdminEmails === false) {
    logger.info(`[notificationService] Recipient blocks admin emails — "${subject}" to ${to} skipped`);
    return null;
  }
  // Subscribable types honour the per-type preference (only when we know the user).
  if (type && subscribable && user) {
    const subscribed = await emailPreferenceService.isSubscribed(user._id, key, type);
    if (!subscribed) {
      logger.info(`[notificationService] Recipient unsubscribed from "${key}" — "${subject}" to ${to} skipped`);
      return null;
    }
  }

  if (dedupeKey) {
    const existing = await Notification.findOne({ dedupeKey }).select('_id').lean();
    if (existing) return null;
  }

  // ── Footer ─────────────────────────────────────────────────────────
  // Mint a signed, expiring, per-recipient unsubscribe token. Its scope
  // (specific type, or the master admin-contact toggle) is baked into the
  // signature, and the user's notificationToken is mixed into the key so
  // rotating it invalidates the link.
  let token = null;
  if (user) {
    const notifToken = await emailPreferenceService.ensureToken(user);
    const scope = (senderType === 'admin' && !subscribable) ? 'admin' : `type:${key}`;
    token = unsubscribeTokenService.sign({ userId: user._id, scope, notificationToken: notifToken });
  }
  const footer = buildFooter({ senderType, subscribable, typeKey: key, token });

  // ── Branded header / footer ────────────────────────────────────────
  // Platform-wide branding blocks wrap the body, gated by both the global
  // switches and this type's per-type opt-in. They sit above the mandatory
  // unsubscribe footer.
  const branding = await emailBrandingService.get();
  const brand = resolveBranding(branding, type);
  const finalHtml = html != null
    ? `${brand.header}${html}${brand.footer}${footer.html}`
    : html;
  const brandHeaderText = brand.header ? `${htmlToText(brand.header)}\n\n` : '';
  const brandFooterText = brand.footer ? `\n\n${htmlToText(brand.footer)}` : '';
  const finalText = text != null
    ? `${brandHeaderText}${text}${brandFooterText}${footer.text}`
    : text;

  const doc = await Notification.create({
    to,
    subject,
    html: finalHtml,
    text: finalText,
    category: key || category,
    typeKey: key,
    senderType,
    senderUserId: senderUserId != null ? String(senderUserId) : null,
    recipientUserId: user ? String(user._id) : (recipientUserId != null ? String(recipientUserId) : null),
    unsubscribable: senderType === 'user' ? true : subscribable,
    refType,
    refId: refId != null ? String(refId) : null,
    dedupeKey,
  });
  return doc;
}

/**
 * Queue the same notification to every user holding one of `roles`
 * (verified email required). Gating and the per-recipient footer are applied
 * individually inside enqueue().
 */
async function enqueueForRoles(roles, { subject, html, text, category, typeKey, senderType = 'system', senderUserId = null, refType, refId, dedupeKey }) {
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
      to: u.email, subject, html, text, category, typeKey,
      senderType, senderUserId, recipientUserId: u._id,
      refType, refId,
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

// CSP for serving an email preview in the browser. Emails style themselves with
// inline `style="..."` attributes, which the app-wide CSP strips — so a preview
// needs one that permits inline styles but forbids scripts/forms to stay safe.
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'";

/**
 * Full standalone HTML document previewing how an emailType's message looks.
 * Pass the current `branding` doc to preview the global header/footer as the
 * recipient would see it; the type's own `actions` are shown when configured,
 * otherwise a single example button.
 */
function renderPreviewDocument(type, branding = null) {
  const actions = Array.isArray(type.actions) && type.actions.length
    ? type.actions.map((a) => ({ text: a.label, url: a.url }))
    : [{ text: 'Open Heron CS', url: baseUrl() + '/' }];
  const html = wrapTemplate({
    heading: type.heading || type.label,
    bodyLines: [type.intro || '', type.description || 'Example notification body.'].filter(Boolean),
    actions,
  });
  const footer = buildFooter({
    senderType: type.senderType,
    subscribable: type.subscribable,
    typeKey: type.key,
    token: null,
  });
  const brand = resolveBranding(branding, type);
  const safeTitle = escapeHtml(type.label || '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preview — ${safeTitle}</title></head><body style="margin:0;padding:24px;background:#f3f4f6;">${brand.header}${html}${brand.footer}${footer.html}</body></html>`;
}

module.exports = {
  enqueue,
  enqueueForRoles,
  processOutbox,
  wrapTemplate,
  buildFooter,
  resolveBranding,
  baseUrl,
  renderPreviewDocument,
  PREVIEW_CSP,
};
