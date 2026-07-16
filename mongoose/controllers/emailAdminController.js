'use strict';

const path = require('path');
const { body, validationResult } = require('express-validator');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const emailTypeService = require('../services/emailTypeService');
const notificationService = require('../../services/notificationService');
const emailPreferenceService = require('../services/emailPreferenceService');

const VIEW = (name) => path.join('tailwindcss', 'settings', name);

function firstError(errors) {
  return errors.array().map((e) => e.msg).join(' ');
}

// ── Hub ───────────────────────────────────────────────────────────────
exports.getHub = async (req, res, next) => {
  try {
    const types = await emailTypeService.list();
    const counts = { total: types.length, enabled: types.filter((t) => t.enabled).length };
    res.render(VIEW('email-hub'), { title: 'Email & Notifications', types, counts });
  } catch (err) { next(err); }
};

// ── Catalog ───────────────────────────────────────────────────────────
exports.getTypes = async (req, res, next) => {
  try {
    const types = await emailTypeService.list();
    res.render(VIEW('email-types'), { title: 'Email Types', types });
  } catch (err) { next(err); }
};

exports.validateType = [
  body('key').optional({ checkFalsy: true }).trim()
    .matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).withMessage('Key must be kebab-case (lowercase letters, digits, hyphens).'),
  body('label').trim().notEmpty().withMessage('Label is required.').isLength({ max: 120 }),
  body('senderType').optional().isIn(['system', 'admin']).withMessage('Invalid sender type.'),
];

function readTypeBody(req) {
  return {
    label: req.body.label,
    description: req.body.description,
    senderType: req.body.senderType,
    subscribable: req.body.subscribable === 'on' || req.body.subscribable === 'true',
    defaultOn: req.body.defaultOn === 'on' || req.body.defaultOn === 'true',
    enabled: req.body.enabled === 'on' || req.body.enabled === 'true',
    subjectPrefix: req.body.subjectPrefix,
    intro: req.body.intro,
  };
}

exports.postCreateType = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.flash('error', firstError(errors));
    return res.redirect('/admin/emails/types');
  }
  try {
    await emailTypeService.create({ key: req.body.key, ...readTypeBody(req) });
    req.flash('success', `Email type "${req.body.key}" created.`);
  } catch (err) {
    req.flash('error', err.code === 11000 ? 'A type with that key already exists.' : `Could not create type: ${err.message}`);
  }
  res.redirect('/admin/emails/types');
};

exports.postUpdateType = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.flash('error', firstError(errors));
    return res.redirect('/admin/emails/types');
  }
  try {
    const updated = await emailTypeService.update(req.params.key, readTypeBody(req));
    if (!updated) req.flash('error', 'Type not found.');
    else req.flash('success', `Email type "${req.params.key}" updated.`);
  } catch (err) {
    req.flash('error', `Could not update type: ${err.message}`);
  }
  res.redirect('/admin/emails/types');
};

exports.postToggleType = async (req, res) => {
  try {
    const enabled = !(req.body.enabled === 'false' || req.body.enabled === false);
    await emailTypeService.setEnabled(req.params.key, enabled);
    req.flash('success', `Email type "${req.params.key}" ${enabled ? 'enabled' : 'disabled'}.`);
  } catch (err) {
    req.flash('error', `Could not toggle type: ${err.message}`);
  }
  res.redirect('/admin/emails/types');
};

exports.postDeleteType = async (req, res) => {
  try {
    const result = await emailTypeService.remove(req.params.key);
    if (result.removed) req.flash('success', `Email type "${req.params.key}" deleted.`);
    else if (result.reason === 'core') req.flash('error', 'Core email types cannot be deleted — disable it instead.');
    else req.flash('error', 'Type not found.');
  } catch (err) {
    req.flash('error', `Could not delete type: ${err.message}`);
  }
  res.redirect('/admin/emails/types');
};

// ── Compose & send ──────────────────────────────────────────────────────
exports.getCompose = async (req, res, next) => {
  try {
    const [users, allTypes] = await Promise.all([
      mdb.INTERNAL.user.find({ email: { $nin: [null, ''] } })
        .select('username email role emailVerified').sort({ username: 1 }).lean(),
      emailTypeService.list(),
    ]);
    const adminTypes = allTypes.filter((t) => t.senderType === 'admin' && t.enabled);
    const roles = ['none', 'subcontractor', 'employee', 'accountant', 'hmrc', 'admin', 'client'];
    res.render(VIEW('email-compose'), { title: 'Compose Email', users, adminTypes, roles });
  } catch (err) { next(err); }
};

exports.validateCompose = [
  body('subject').trim().notEmpty().withMessage('Subject is required.').isLength({ max: 300 }),
  body('message').trim().notEmpty().withMessage('Message body is required.'),
  body('recipientType').isIn(['user', 'role']).withMessage('Choose a recipient.'),
];

exports.postCompose = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.flash('error', firstError(errors));
    return res.redirect('/admin/emails/compose');
  }
  try {
    const { subject, message, recipientType, userId, role } = req.body;
    const typeKey = req.body.typeKey || 'admin-message';
    const type = await emailTypeService.get(typeKey);
    const senderUserId = req.session.user && req.session.user.id;

    const html = notificationService.wrapTemplate({
      heading: (type && type.subjectPrefix) || subject,
      bodyLines: String(message).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
    });
    const text = String(message);

    let queued = 0;
    if (recipientType === 'role') {
      const result = await notificationService.enqueueForRoles([role], {
        subject, html, text, typeKey, senderType: 'admin', senderUserId,
      });
      queued = result.queued;
    } else {
      const target = await mdb.INTERNAL.user.findById(userId).select('email').lean();
      if (!target || !target.email) {
        req.flash('error', 'Selected user has no email address.');
        return res.redirect('/admin/emails/compose');
      }
      const doc = await notificationService.enqueue({
        to: target.email, subject, html, text, typeKey,
        senderType: 'admin', senderUserId, recipientUserId: userId,
      });
      queued = doc ? 1 : 0;
    }

    if (queued > 0) req.flash('success', `Email queued to ${queued} recipient${queued === 1 ? '' : 's'}.`);
    else req.flash('error', 'Nothing was queued — the recipient(s) may have unsubscribed or blocked admin emails.');
  } catch (err) {
    logger.error(`[emailAdminController] compose failed: ${err.message}`);
    req.flash('error', `Could not send: ${err.message}`);
  }
  res.redirect('/admin/emails/compose');
};

// ── Outbox ──────────────────────────────────────────────────────────────
exports.getOutbox = async (req, res, next) => {
  try {
    const notifications = await mdb.INTERNAL.notification.find({})
      .sort({ createdAt: -1 }).limit(100).lean();
    res.render(VIEW('email-outbox'), { title: 'Email Outbox', notifications });
  } catch (err) { next(err); }
};

exports.postResend = async (req, res) => {
  try {
    await mdb.INTERNAL.notification.updateOne(
      { uuid: req.params.uuid },
      { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    );
    req.flash('success', 'Notification re-queued for delivery.');
  } catch (err) {
    req.flash('error', `Could not resend: ${err.message}`);
  }
  res.redirect('/admin/emails/outbox');
};

exports.postCancel = async (req, res) => {
  try {
    await mdb.INTERNAL.notification.updateOne(
      { uuid: req.params.uuid, status: 'pending' },
      { status: 'cancelled' },
    );
    req.flash('success', 'Pending notification cancelled.');
  } catch (err) {
    req.flash('error', `Could not cancel: ${err.message}`);
  }
  res.redirect('/admin/emails/outbox');
};

// ── Public token-scoped unsubscribe (no login, hostile-safe) ─────────────
function maskEmail(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  return `${value.slice(0, 2)}***@${value.slice(at + 1)}`;
}

// GET is READ-ONLY: it only renders a confirmation page. Email link-scanners /
// prefetchers issuing a GET change nothing.
exports.getUnsubscribe = async (req, res) => {
  const { token, type, admin } = req.query;
  const user = await emailPreferenceService.resolveByToken(token);
  if (!user) {
    return res.status(400).render(path.join('tailwindcss', 'notifications', 'unsubscribed'), {
      title: 'Unsubscribe', ok: false,
      message: 'This unsubscribe link is invalid or has expired.',
    });
  }
  let mode = 'admin-contact';
  let typeDoc = null;
  if (!admin && type) {
    typeDoc = await emailTypeService.get(type);
    mode = 'type';
  }
  res.render(path.join('tailwindcss', 'notifications', 'unsubscribe-confirm'), {
    title: 'Confirm unsubscribe',
    token,
    mode,
    type: type || '',
    typeDoc,
    maskedEmail: maskEmail(user.email),
  });
};

// POST performs the change — only after the explicit button press. The token
// authorises ONLY this one preference change for this one recipient.
exports.postUnsubscribe = async (req, res) => {
  const { token, type, mode } = req.body;
  const user = await emailPreferenceService.resolveByToken(token);
  if (!user) {
    return res.status(400).render(path.join('tailwindcss', 'notifications', 'unsubscribed'), {
      title: 'Unsubscribe', ok: false,
      message: 'This unsubscribe link is invalid or has expired.',
    });
  }
  try {
    if (mode === 'admin-contact') {
      await emailPreferenceService.setAllowAdminEmails(user._id, false);
      return res.render(path.join('tailwindcss', 'notifications', 'unsubscribed'), {
        title: 'Unsubscribed', ok: true,
        message: 'Administrators can no longer contact you by email. You can re-enable this anytime from your notification settings.',
      });
    }
    const done = await emailPreferenceService.setPreference(user._id, type, false);
    const typeDoc = await emailTypeService.get(type);
    return res.render(path.join('tailwindcss', 'notifications', 'unsubscribed'), {
      title: 'Unsubscribed', ok: done,
      message: done
        ? `You have been unsubscribed from "${typeDoc ? typeDoc.label : type}" emails.`
        : 'This notification type cannot be unsubscribed from.',
    });
  } catch (err) {
    logger.error(`[emailAdminController] unsubscribe failed: ${err.message}`);
    return res.status(500).render(path.join('tailwindcss', 'notifications', 'unsubscribed'), {
      title: 'Unsubscribe', ok: false, message: 'Something went wrong. Please try again later.',
    });
  }
};
