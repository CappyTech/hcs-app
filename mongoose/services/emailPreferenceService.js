/**
 * emailPreferenceService — per-user subscription state and the master
 * "allow admins to email me" switch.
 *
 * Subscription resolution: an explicit emailPreference row wins; otherwise fall
 * back to the emailType's defaultOn. Non-subscribable types are always "on"
 * (they cannot be unsubscribed from).
 *
 * Channels (email, SMS, in-app): resolveChannels() is the one rule for which
 * channels a person gets for a type. The email channel is the original
 * `subscribed` flag; SMS and in-app are the `sms` / `inApp` flags on the same
 * emailPreference row, falling back to the type's smsDefaultOn / inAppDefaultOn.
 */

import crypto from 'crypto';
import mdb from './mongooseDatabaseService.js';
import emailTypeService from './emailTypeService.js';

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
  // A row may hold only an SMS / in-app choice; then email keeps its default.
  if (pref && typeof pref.subscribed === 'boolean') return pref.subscribed;
  return t.defaultOn !== false;
}

const CHANNELS = ['email', 'sms', 'inApp'];
// emailPreference field holding each channel's choice.
const PREF_FIELD = { email: 'subscribed', sms: 'sms', inApp: 'inApp' };

/** Channels the type can be delivered on (older docs have no `channels`: email only). */
function supportedChannels(type) {
  const list = type && Array.isArray(type.channels) && type.channels.length ? type.channels : ['email'];
  return CHANNELS.filter((c) => list.includes(c));
}

/** The type's default for each channel, before any personal choice. */
function typeDefaults(type) {
  return {
    email: !type || type.defaultOn !== false,
    sms: !!(type && type.smsDefaultOn),
    inApp: !!(type && type.inAppDefaultOn),
  };
}

/**
 * Per-channel detail for one type and one person, for the preferences page and
 * for resolveChannels. Pure: pass the type, the person's emailPreference row
 * for that type (or null) and the user (for the phone number / email).
 *
 * Each channel: { supported, on, locked, reason }
 *   supported  the type can use this channel at all
 *   on         this person gets it (after defaults, choice, phone/email checks)
 *   chosen     what the person's setting says (before phone/email checks)
 *   locked     the person may not change it (unsubscribable type, or SMS
 *              without a phone number)
 *   reason     why it is locked/off: 'required', 'no-phone', 'no-email', null
 */
function channelDetail({ type, pref = null, user = null }) {
  const supported = supportedChannels(type);
  const defaults = typeDefaults(type);
  const subscribable = !!(type && type.subscribable);
  const out = {};
  for (const channel of CHANNELS) {
    const isSupported = supported.includes(channel);
    let chosen = defaults[channel];
    if (subscribable && pref && typeof pref[PREF_FIELD[channel]] === 'boolean') {
      chosen = pref[PREF_FIELD[channel]];
    }
    // Unsubscribable types: email is always on (as before); the other
    // channels follow the type's defaults and cannot be changed.
    if (!subscribable && channel === 'email') chosen = true;
    let on = isSupported && chosen;
    let locked = !subscribable;
    let reason = !subscribable ? 'required' : null;
    if (channel === 'sms' && !(user && String(user.phoneNumber || '').trim())) {
      on = false;
      locked = true;
      reason = 'no-phone';
    }
    if (channel === 'email' && user && !String(user.email || '').trim()) {
      on = false;
      reason = 'no-email';
    }
    out[channel] = { supported: isSupported, on: !!on, chosen: !!chosen, locked, reason };
  }
  return out;
}

/**
 * Which channels `user` gets for `type`: { email, sms, inApp } booleans.
 *  - a disabled or missing type: nothing;
 *  - channels the type does not support: off;
 *  - subscribable types: the person's saved choice per channel, else the
 *    type's default (defaultOn / smsDefaultOn / inAppDefaultOn);
 *  - unsubscribable types (e.g. security): the type's defaults, and email is
 *    always on — the person cannot turn them off;
 *  - SMS only for users with a phone number; email only with an address.
 */
function resolveChannels({ type, pref = null, user = null }) {
  if (!type || type.enabled === false) return { email: false, sms: false, inApp: false };
  const d = channelDetail({ type, pref, user });
  return { email: d.email.on, sms: d.sms.on, inApp: d.inApp.on };
}

/**
 * Merge every catalog type with this user's effective subscription state, for
 * the personal dashboard. Only `enabled` types are returned.
 */
async function getPreferencesForUser(userId, user = null) {
  const EmailPreference = prefModel();
  const types = (await emailTypeService.list()).filter((t) => t.enabled);
  const rows = EmailPreference && userId
    ? await EmailPreference.find({ userId: String(userId) }).select('typeKey subscribed sms inApp').lean()
    : [];
  const byType = new Map(rows.map((r) => [r.typeKey, r]));
  return types.map((t) => {
    const pref = byType.get(t.key) || null;
    const hasEmailChoice = !!pref && typeof pref.subscribed === 'boolean';
    return {
      ...t,
      subscribed: !t.subscribable ? true : (hasEmailChoice ? pref.subscribed : t.defaultOn !== false),
      isExplicit: hasEmailChoice,
      // Per-channel detail; `user` (email, phoneNumber) lets it mark SMS as
      // unavailable without a phone number. Without a user, SMS shows as such.
      channels: channelDetail({ type: t, pref, user }),
    };
  });
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

/**
 * Turn one channel on or off for one type. Returns false (no change) for an
 * unknown or unsubscribable type, an unknown channel, or a channel the type
 * does not support. The email channel writes the original `subscribed` flag.
 */
async function setChannelPreference(userId, typeKey, channel, on) {
  const EmailPreference = prefModel();
  if (!EmailPreference || !userId || !typeKey || !CHANNELS.includes(channel)) return false;
  const t = await emailTypeService.get(typeKey);
  if (!t || !t.subscribable) return false;
  if (!supportedChannels(t).includes(channel)) return false;
  await EmailPreference.findOneAndUpdate(
    { userId: String(userId), typeKey: String(typeKey).toLowerCase() },
    { [PREF_FIELD[channel]]: !!on },
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
  const token = crypto.randomBytes(24).toString('hex');
  if (User && userDoc._id) await User.updateOne({ _id: userDoc._id }, { notificationToken: token });
  return token;
}

/** Resolve the user behind a legacy static unsubscribe token (lean). */
async function resolveByToken(token) {
  const User = userModel();
  if (!User || !token) return null;
  return User.findOne({ notificationToken: String(token) }).lean();
}

/**
 * Rotate a user's notificationToken. Because the token is mixed into the HMAC
 * key of every signed unsubscribe link (see unsubscribeTokenService), this
 * invalidates all of that user's outstanding unsubscribe links at once — and
 * only that user's. Returns the new token.
 */
async function rotateToken(userId) {
  const User = userModel();
  if (!User || !userId) return null;
  const token = crypto.randomBytes(24).toString('hex');
  await User.updateOne({ _id: userId }, { notificationToken: token });
  return token;
}

export default {
  CHANNELS,
  isSubscribed,
  supportedChannels,
  channelDetail,
  resolveChannels,
  getPreferencesForUser,
  setPreference,
  setChannelPreference,
  setAllowAdminEmails,
  ensureToken,
  resolveByToken,
  rotateToken,
};

export { CHANNELS, isSubscribed, supportedChannels, channelDetail, resolveChannels, getPreferencesForUser, setPreference, setChannelPreference, setAllowAdminEmails, ensureToken, resolveByToken, rotateToken };
