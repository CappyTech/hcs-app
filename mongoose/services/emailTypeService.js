'use strict';

/**
 * emailTypeService — CRUD + resolver over the DB-driven emailType catalog.
 *
 * Used by:
 *  - emailAdminController for the admin catalog UI (/admin/emails/types)
 *  - notificationService.enqueue to resolve a type and gate sending
 */

const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');

function model() {
  return mdb.INTERNAL && mdb.INTERNAL.emailType;
}

/** All types, newest core first then alphabetical-ish by label. */
async function list() {
  const EmailType = model();
  if (!EmailType) return [];
  return EmailType.find({}).sort({ senderType: 1, label: 1 }).lean();
}

async function get(key) {
  const EmailType = model();
  if (!EmailType || !key) return null;
  return EmailType.findOne({ key: String(key).toLowerCase() }).lean();
}

async function create(data) {
  const EmailType = model();
  if (!EmailType) throw new Error('emailType model unavailable');
  const doc = await EmailType.create({
    key: data.key,
    label: data.label,
    description: data.description || '',
    senderType: data.senderType === 'admin' ? 'admin' : 'system',
    subscribable: data.subscribable !== false,
    defaultOn: data.defaultOn !== false,
    enabled: data.enabled !== false,
    heading: data.heading || '',
    intro: data.intro || '',
    isCore: false,
  });
  return doc.toObject();
}

/** Update editable fields of an existing type (core or not). Never changes `key` or `isCore`. */
async function update(key, data) {
  const EmailType = model();
  if (!EmailType) throw new Error('emailType model unavailable');
  const patch = {};
  for (const f of ['label', 'description', 'senderType', 'subscribable', 'defaultOn', 'enabled', 'heading', 'intro']) {
    if (data[f] !== undefined) patch[f] = data[f];
  }
  if (patch.senderType && patch.senderType !== 'admin') patch.senderType = 'system';
  return EmailType.findOneAndUpdate({ key: String(key).toLowerCase() }, patch, { new: true }).lean();
}

async function setEnabled(key, enabled) {
  const EmailType = model();
  if (!EmailType) throw new Error('emailType model unavailable');
  return EmailType.findOneAndUpdate(
    { key: String(key).toLowerCase() },
    { enabled: !!enabled },
    { new: true },
  ).lean();
}

/** Delete a non-core type. Core types are protected (code depends on them). */
async function remove(key) {
  const EmailType = model();
  if (!EmailType) throw new Error('emailType model unavailable');
  const doc = await EmailType.findOne({ key: String(key).toLowerCase() });
  if (!doc) return { removed: false, reason: 'not-found' };
  if (doc.isCore) return { removed: false, reason: 'core' };
  await doc.deleteOne();
  return { removed: true };
}

/**
 * Resolve a type by key for a sender. If the key is unknown, register a
 * DISABLED stub so the type surfaces in the admin UI (an admin can then enable
 * it) rather than silently sending under an unmanaged key.
 */
async function resolveOrRegister(key) {
  const EmailType = model();
  if (!EmailType || !key) return null;
  const k = String(key).toLowerCase();
  let doc = await EmailType.findOne({ key: k }).lean();
  if (doc) return doc;
  try {
    doc = await EmailType.create({
      key: k,
      label: k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description: 'Auto-registered from a code sender. Review and enable to activate.',
      senderType: 'system',
      subscribable: true,
      defaultOn: true,
      enabled: false, // disabled until an admin reviews it
      isCore: false,
    });
    logger.warn(`[emailTypeService] Auto-registered unknown email type "${k}" (disabled).`);
    return doc.toObject();
  } catch (err) {
    // Race: another request created it first — re-read.
    return EmailType.findOne({ key: k }).lean();
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  setEnabled,
  remove,
  resolveOrRegister,
};
