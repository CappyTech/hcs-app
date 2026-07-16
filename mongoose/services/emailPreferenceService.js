'use strict';

/**
 * emailPreferenceService — per-user subscription state and the master
 * "allow admins to email me" switch.
 *
 * Subscription resolution: an explicit emailPreference row wins; otherwise fall
 * back to the emailType's defaultOn. Non-subscribable types are always "on"
 * (they cannot be unsubscribed from).
 */

const mdb = require('./mongooseDatabaseService');
const emailTypeService = require('./emailTypeService');

function prefModel() {
  return mdb.INTERNAL && mdb.INTERNAL.emailPreference;
}
function userModel() {
  return mdb.INTERNAL && mdb.INTERNAL.user;
}

/**
 * Is `userId` subscribed to `typeKey`? Non-subscribable types always return
 * true. Missing type ⇒ false (nothing to send).
 * @param {string} userId
 * @param {string} typeKey
 * @param {object} [type] optional pre-fetched emailType to avoid a round-trip
 */
async function isSubscribed(userId, typeKey, type = undefined) {
  const EmailPreference = prefModel();
  if (!typeKey) return true; // ad-hoc sends aren't gated by subscription here
  const t = type !== undefined ? type : await emailTypeService.get(typeKey);
  if (!t) return false;
  if (!t.subscribable) return true; // mandatory
  if (!EmailPreference || !userId) return t.defaultOn !== false;
  const pref = await EmailPreference.findOne({ userId: String(userId), typeKey }).select('subscribed').lean();
  if (pref) return !!pref.subscribed;
  return t.defaultOn !== false;
}

/**
 * Merge every catalog type with this user's effective subscription state, for
 * the personal dashboard. Only `enabled` types are returned.
 */
async function getPreferencesForUser(userId) {
  const EmailPreference = prefModel();
  const types = (await emailTypeService.list()).filter((t) => t.enabled);
  const rows = EmailPreference && userId
    ? await EmailPreference.find({ userId: String(userId) }).select('typeKey subscribed').lean()
    : [];
  const explicit = new Map(rows.map((r) => [r.typeKey, !!r.subscribed]));
  return types.map((t) => ({
    ...t,
    subscribed: !t.subscribable ? true : (explicit.has(t.key) ? explicit.get(t.key) : t.defaultOn !== false),
    isExplicit: explicit.has(t.key),
  }));
}

/** Upsert a preference. No-op (returns false) for non-subscribable/unknown types. */
async function setPreference(userId, typeKey, subscribed) {
  const EmailPreference = prefModel();
  if (!EmailPreference || !userId || !typeKey) return false;
  const t = await emailTypeService.get(typeKey);
  if (!t || !t.subscribable) return false;
  await EmailPreference.findOneAndUpdate(
    { userId: String(userId), typeKey: String(typeKey).toLowerCase() },
    { subscribed: !!subscribed },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return true;
}

/** Set the master "allow admins to email me" switch. */
async function setAllowAdminEmails(userId, allow) {
  const User = userModel();
  if (!User || !userId) return false;
  await User.updateOne({ _id: userId }, { allowAdminEmails: !!allow });
  return true;
}

/**
 * Ensure the user has a notificationToken (older accounts predate the field)
 * and return it. Used when building unsubscribe links.
 */
async function ensureToken(userDoc) {
  const User = userModel();
  if (!userDoc) return null;
  if (userDoc.notificationToken) return userDoc.notificationToken;
  const crypto = require('crypto');
  const token = crypto.randomBytes(24).toString('hex');
  if (User && userDoc._id) await User.updateOne({ _id: userDoc._id }, { notificationToken: token });
  return token;
}

/** Resolve the user behind an unsubscribe token (lean). */
async function resolveByToken(token) {
  const User = userModel();
  if (!User || !token) return null;
  return User.findOne({ notificationToken: String(token) }).lean();
}

module.exports = {
  isSubscribed,
  getPreferencesForUser,
  setPreference,
  setAllowAdminEmails,
  ensureToken,
  resolveByToken,
};
