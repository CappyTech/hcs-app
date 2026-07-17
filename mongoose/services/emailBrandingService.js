'use strict';

/**
 * emailBrandingService — read/upsert the single platform-wide email branding
 * document (global header + footer). Used by:
 *   - emailAdminController for the /admin/emails/branding editor
 *   - notificationService to wrap outgoing emails with the branded blocks
 */

const mdb = require('./mongooseDatabaseService');

const SINGLETON = 'global';

function model() {
  return mdb.INTERNAL && mdb.INTERNAL.emailBranding;
}

/** Current branding (lean). Never throws; returns safe defaults when unset. */
async function get() {
  const EmailBranding = model();
  const defaults = { headerEnabled: false, headerHtml: '', footerEnabled: false, footerHtml: '' };
  if (!EmailBranding) return defaults;
  try {
    const doc = await EmailBranding.findOne({ singleton: SINGLETON }).lean();
    return doc || defaults;
  } catch (_) {
    return defaults;
  }
}

/** Upsert the editable fields. Returns the saved document (lean). */
async function save(data) {
  const EmailBranding = model();
  if (!EmailBranding) throw new Error('emailBranding model unavailable');
  const patch = {};
  for (const f of ['headerEnabled', 'headerHtml', 'footerEnabled', 'footerHtml']) {
    if (data[f] !== undefined) patch[f] = data[f];
  }
  return EmailBranding.findOneAndUpdate(
    { singleton: SINGLETON },
    { $set: patch, $setOnInsert: { singleton: SINGLETON } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

module.exports = { get, save };
