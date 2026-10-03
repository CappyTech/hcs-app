/**
 * documentNotifyService.js — the document emails and Discord posts
 * (Paperless migration H6; PB-1, PB-5, PB-6, PB-8, PB-9, PB-10).
 *
 * Each notification uses the exact Paperless template (PAPERLESS-MIGRATION.md
 * section 3a). Before anything is sent, a one-shot notification is claimed in
 * NotificationLog; the unique index means only one caller ever wins, so each
 * fires exactly once however many paths reach it. Re-sends to John are
 * recorded every time.
 *
 * NOTIFY_MODE decides what a claimed notification does:
 *   shadow (default)  log what would be sent; send nothing. Paperless's own
 *                     workflows keep sending until cutover (H8).
 *   live              send the email (PDF attached) and the Discord post.
 *
 * A live send that fails stays `failed` with per-channel results, and
 * retryFailed() (the paperless-notification-retry job) resends only the
 * channels that failed, a few times, with backoff.
 */

import axios from 'axios';
import mdb from '../mongooseDatabaseService.js';
import { claimOneShot, recordRepeatable } from './notificationLogService.js';
import { ONE_SHOT_KINDS } from '../../models/mongoose/PAPERLESS/NotificationLog.js';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';
import { paperlessUiBase } from './documentQueueService.js';
import __paperlessClient from './paperlessClient.js';
import emailService from '../../../services/emailService.js';
import logger from '../../../services/loggerService.js';

export const SENDER_NAME = 'Heron CS | Documents';
export const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 10 * 60 * 1000;

export function notifyMode() {
  return String(process.env.NOTIFY_MODE || '').trim().toLowerCase() === 'live' ? 'live' : 'shadow';
}

const isPurchaseInvoice = (doc) => isDocumentType(doc?.documentType, 'purchaseInvoice');
const isStatement = (doc) => isDocumentType(doc?.documentType, 'supplierStatement');
const anyDocument = () => true;

const JOHN_EMAIL = {
  to: () => process.env.NOTIFY_JOHN_EMAIL,
  subject: 'New purchase invoice: {{filename}} from {{correspondent}}',
  body: [
    'A new purchase invoice has been added to Heron CS | Documents.',
    '',
    '',
    'Title: {{filename}}',
    'Type: {{document_type}}',
    'Date: {{created}}',
    '',
    '{{doc_url}}',
    '',
    'Document Attached.',
  ].join('\n'),
};

/**
 * What each kind sends and to which documents it applies — the same filters
 * as the Paperless workflow it replaces.
 */
export const KINDS = {
  new_doc: {
    workflow: 'WF8', appliesTo: anyDocument,
    discord: 'New document: {{filename}} ({{document_type}}) from {{correspondent}} - {{doc_url}}',
  },
  john: {
    workflow: 'WF3', appliesTo: isPurchaseInvoice,
    email: JOHN_EMAIL,
    discord: 'Emailed invoice to John: {{filename}} - {{doc_url}}',
  },
  john_resend: {
    workflow: 'WF9', appliesTo: isPurchaseInvoice,
    email: JOHN_EMAIL,
    discord: 'Re-sent invoice to John: {{filename}} - {{doc_url}}',
  },
  kashflow: {
    workflow: 'WF4', appliesTo: anyDocument,
    discord: 'Document added to kashflow: {{filename}} - {{doc_url}}',
  },
  statement: {
    workflow: 'WF2', appliesTo: isStatement,
    email: {
      to: () => process.env.NOTIFY_ADMIN_EMAIL,
      subject: 'New statement: {{filename}} from {{correspondent}}',
      body: [
        'A new statement has been added to https://docs.heroncs.co.uk/',
        '',
        'Title: {{filename}}',
        'Type: {{document_type}}',
        'Date: {{created}}',
        '',
        'Statement: {{doc_url}}',
      ].join('\n'),
    },
    discord: 'Emailed statement to Admin: {{filename}} - {{doc_url}}',
  },
  credit_note: {
    workflow: 'WF5', appliesTo: isPurchaseInvoice,
    email: {
      to: () => process.env.NOTIFY_ADMIN_EMAIL,
      subject: 'New credit note: {{filename}} from {{correspondent}}',
      body: [
        'A new credit note has been added to https://docs.heroncs.co.uk/',
        '',
        'Title: {{filename}}',
        'Type: {{document_type}}',
        'Date: {{created}}',
        '',
        'Credit note: {{doc_url}}',
      ].join('\n'),
    },
    discord: 'Emailed credit note to Admin: {{filename}} - {{doc_url}}',
  },
};

const isoDate = (d) => {
  if (!d) return '';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

/** The section 3a placeholder values for a document. Pure. */
export function placeholders(doc, { uiBase = paperlessUiBase() } = {}) {
  return {
    filename: doc.title || doc.originalFileName || `Document ${doc.paperlessId}`,
    correspondent: doc.correspondent?.name || 'None',
    document_type: doc.documentType?.name || 'None',
    created: isoDate(doc.created),
    doc_url: uiBase ? `${uiBase}/documents/${doc.paperlessId}/details` : `/paperless/ocr/${doc.paperlessId}`,
  };
}

/** Fill {{name}} placeholders. Unknown names are left as written. Pure. */
export function fill(template, values) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

/** The email and Discord message a kind would send for a document. Pure. */
export function buildMessages(kind, doc, opts = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown notification kind "${kind}"`);
  const v = placeholders(doc, opts);
  return {
    email: spec.email ? {
      to: spec.email.to() || null,
      subject: fill(spec.email.subject, v),
      text: fill(spec.email.body, v),
    } : null,
    discord: spec.discord ? {
      username: SENDER_NAME,
      content: fill(spec.discord, v),
    } : null,
  };
}

const defaultDeps = () => ({
  NotificationLog: mdb.PAPERLESS?.NotificationLog,
  OcrDocument: mdb.PAPERLESS?.OcrDocument,
  sendMail: (msg) => emailService.sendMail(msg),
  postDiscord: async (payload) => {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return { skipped: true };
    await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 });
    return { sent: true };
  },
  getPdf: async (paperlessId) => {
    const { stream, contentType } = await __paperlessClient.makeClient().getDocumentFile(paperlessId);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return { content: Buffer.concat(chunks), contentType };
  },
});

const truncate = (s, n = 500) => String(s ?? '').slice(0, n);

/** Send (or, for `only`, resend) the channels of one notification. */
async function deliver(messages, doc, d, { mode, only = null }) {
  const results = [];
  const now = () => new Date();

  if (messages.email && (!only || only.includes('email'))) {
    const to = messages.email.to;
    if (!to) {
      results.push({ channel: 'email', status: 'skipped', to: null, error: 'No recipient configured', at: now() });
    } else if (mode === 'shadow') {
      results.push({ channel: 'email', status: 'shadow', to, error: null, at: now() });
    } else {
      try {
        const pdf = await d.getPdf(doc.paperlessId);
        const filename = doc.originalFileName || `${doc.title || doc.paperlessId}.pdf`;
        const res = await d.sendMail({
          to,
          subject: messages.email.subject,
          text: messages.email.text,
          fromName: SENDER_NAME,
          attachments: [{ filename, content: pdf.content, contentType: /pdf/i.test(pdf.contentType || '') ? 'application/pdf' : pdf.contentType }],
        });
        if (res && res.fallback) throw new Error('No email transport is configured (SMTP or Microsoft Graph).');
        results.push({ channel: 'email', status: 'sent', to, error: null, at: now() });
      } catch (err) {
        results.push({ channel: 'email', status: 'failed', to, error: truncate(err.message), at: now() });
      }
    }
  }

  if (messages.discord && (!only || only.includes('discord'))) {
    if (mode === 'shadow') {
      results.push({ channel: 'discord', status: 'shadow', to: null, error: null, at: now() });
    } else {
      try {
        const r = await d.postDiscord(messages.discord);
        results.push({ channel: 'discord', status: r && r.skipped ? 'skipped' : 'sent', to: null, error: r && r.skipped ? 'DISCORD_WEBHOOK_URL is not set' : null, at: now() });
      } catch (err) {
        results.push({ channel: 'discord', status: 'failed', to: null, error: truncate(err.message), at: now() });
      }
    }
  }
  return results;
}

const overallStatus = (mode, channels) => {
  if (mode === 'shadow') return 'shadow';
  return channels.some((c) => c.status === 'failed') ? 'failed' : 'sent';
};

/**
 * Fire one notification for a document. Safe to call from any path: a
 * one-shot kind that was already claimed is a no-op.
 * @param {string} kind - a key of KINDS
 * @param {number} paperlessId
 * @param {{actor?, source?: 'app'|'paperless', deps?, mode?}} [opts]
 * @returns {Promise<{fired: boolean, reason?: string, status?: string, channels?: Array}>}
 */
export async function notify(kind, paperlessId, { actor = null, source = 'app', deps = {}, mode = notifyMode() } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unknown notification kind "${kind}"`);
  const d = { ...defaultDeps(), ...deps };
  if (!d.NotificationLog || !d.OcrDocument) {
    logger.warn(`[documentNotify] Models unavailable; ${kind} for ${paperlessId} not recorded`);
    return { fired: false, reason: 'unavailable' };
  }

  const doc = await d.OcrDocument.findOne({ paperlessId })
    .select('paperlessId title originalFileName correspondent documentType created')
    .lean();
  if (!doc) return { fired: false, reason: 'not-found' };
  if (!spec.appliesTo(doc)) return { fired: false, reason: 'not-applicable' };

  let entry;
  if (ONE_SHOT_KINDS.includes(kind)) {
    const claim = await claimOneShot(d.NotificationLog, paperlessId, kind, { actor, mode, source });
    if (!claim.claimed) return { fired: false, reason: 'already-sent' };
    entry = claim.entry;
  } else {
    entry = await recordRepeatable(d.NotificationLog, paperlessId, kind, { actor, mode, source });
  }

  const messages = buildMessages(kind, doc);
  const channels = await deliver(messages, doc, d, { mode });
  const status = overallStatus(mode, channels);
  await d.NotificationLog.updateOne(
    { _id: entry._id },
    { $set: { status, channels, error: channels.find((c) => c.error && c.status === 'failed')?.error ?? null, lastAttemptAt: new Date() }, $inc: { attempts: 1 } },
  );

  const summary = channels.map((c) => `${c.channel}=${c.status}`).join(' ');
  if (mode === 'shadow') {
    logger.info(`[documentNotify] SHADOW would send ${kind} (${spec.workflow}) for paperlessId=${paperlessId}: ${summary}`
      + (messages.email ? ` | email to ${messages.email.to || '(unset)'}: "${messages.email.subject}"` : '')
      + (messages.discord ? ` | discord: "${messages.discord.content}"` : ''));
  } else {
    const level = status === 'failed' ? 'warn' : 'info';
    logger[level](`[documentNotify] ${kind} for paperlessId=${paperlessId}: ${summary}`);
  }
  return { fired: true, status, channels };
}

/** notify(), but a failure is logged rather than thrown: an action must not fail because a notification did. */
export async function notifySafely(kind, paperlessId, opts = {}) {
  try {
    return await notify(kind, paperlessId, opts);
  } catch (err) {
    logger.error(`[documentNotify] ${kind} for paperlessId=${paperlessId} failed: ${err.message}`);
    return { fired: false, reason: 'error', error: err.message };
  }
}

/**
 * Resend the failed channels of live notifications that failed, with
 * backoff, up to MAX_ATTEMPTS. The paperless-notification-retry job.
 */
export async function retryFailed({ deps = {}, now = new Date(), limit = 20 } = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (!d.NotificationLog || !d.OcrDocument) return { retried: 0, sent: 0, failed: 0 };
  const due = await d.NotificationLog.find({ status: 'failed', mode: 'live', attempts: { $lt: MAX_ATTEMPTS } })
    .sort({ lastAttemptAt: 1 })
    .limit(limit)
    .lean();

  let retried = 0, sent = 0, failed = 0;
  for (const row of due) {
    const wait = RETRY_BASE_MS * 2 ** Math.max(0, (row.attempts || 1) - 1);
    if (row.lastAttemptAt && now.getTime() - new Date(row.lastAttemptAt).getTime() < wait) continue;
    const doc = await d.OcrDocument.findOne({ paperlessId: row.paperlessId })
      .select('paperlessId title originalFileName correspondent documentType created')
      .lean();
    if (!doc) continue;
    const only = (row.channels || []).filter((c) => c.status === 'failed').map((c) => c.channel);
    if (!only.length) continue;
    retried++;
    const fresh = await deliver(buildMessages(row.kind, doc), doc, d, { mode: 'live', only });
    const channels = (row.channels || []).map((c) => fresh.find((f) => f.channel === c.channel) || c);
    const status = overallStatus('live', channels);
    if (status === 'sent') sent++; else failed++;
    await d.NotificationLog.updateOne(
      { _id: row._id },
      { $set: { status, channels, error: channels.find((c) => c.status === 'failed')?.error ?? null, lastAttemptAt: now }, $inc: { attempts: 1 } },
    );
  }
  if (retried) logger.info(`[documentNotify] Retried ${retried} failed notification(s): sent=${sent} failed=${failed}`);
  return { retried, sent, failed };
}

/** A document's notifications, newest first, for the entry screen. */
export async function historyFor(NotificationLog, paperlessId) {
  if (!NotificationLog) return [];
  return NotificationLog.find({ paperlessId }).sort({ createdAt: -1 }).limit(50).lean();
}

export default {
  SENDER_NAME, MAX_ATTEMPTS, KINDS, notifyMode, placeholders, fill, buildMessages, notify, notifySafely, retryFailed, historyFor,
};
