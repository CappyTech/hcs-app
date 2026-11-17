/**
 * inAppNotificationService — the in-app notification store.
 *
 * notifyService.notifyUsers calls create(); the /notifications page and the
 * header bell use list(), unreadCount(), markRead() and markAllRead(). Every
 * read and write is scoped to one userId, so a person can only see or mark
 * their own notifications.
 */

import mdb from './mongooseDatabaseService.js';

function model() {
  return mdb.INTERNAL && mdb.INTERNAL.inAppNotification;
}

/**
 * Keep a link only when it is a path on this site ('/attendance/…'). Absolute
 * URLs and protocol-relative ones ('//evil.example') are dropped, so a notice
 * can never send someone off-site.
 */
function safeLink(link) {
  if (typeof link !== 'string') return null;
  const value = link.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\s<>"]/.test(value)) return null;
  return value.slice(0, 500);
}

/**
 * Store one notification. Returns the created doc, or null when the model is
 * unavailable, the input is incomplete, or `dedupeKey` was already used.
 */
async function create({ userId, typeKey = null, title, body = '', link = null, dedupeKey = null }) {
  const InApp = model();
  if (!InApp || !userId || !title) return null;
  if (dedupeKey) {
    const existing = await InApp.findOne({ dedupeKey }).select('_id').lean();
    if (existing) return null;
  }
  return InApp.create({
    userId: String(userId),
    typeKey,
    title: String(title).slice(0, 300),
    body: String(body || '').slice(0, 5000),
    link: safeLink(link),
    dedupeKey,
  });
}

/** One page of a person's notifications, newest first. */
async function list(userId, { page = 1, perPage = 25 } = {}) {
  const InApp = model();
  if (!InApp || !userId) return { items: [], total: 0, page: 1, pages: 1, unread: 0 };
  const filter = { userId: String(userId) };
  const total = await InApp.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const items = await InApp.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((current - 1) * perPage)
    .limit(perPage)
    .lean();
  const unread = await unreadCount(userId);
  return { items, total, page: current, pages, unread };
}

async function unreadCount(userId) {
  const InApp = model();
  if (!InApp || !userId) return 0;
  return InApp.countDocuments({ userId: String(userId), readAt: null });
}

/**
 * Mark one of this person's notifications read. Returns the (lean) doc, or
 * null when it does not exist or belongs to someone else.
 */
async function markRead(userId, uuid) {
  const InApp = model();
  if (!InApp || !userId || !uuid) return null;
  const doc = await InApp.findOne({ uuid: String(uuid), userId: String(userId) }).lean();
  if (!doc) return null;
  if (!doc.readAt) {
    const readAt = new Date();
    await InApp.updateOne({ _id: doc._id, readAt: null }, { readAt });
    doc.readAt = readAt;
  }
  return doc;
}

/** Mark every unread notification of this person read. Returns how many. */
async function markAllRead(userId) {
  const InApp = model();
  if (!InApp || !userId) return 0;
  const res = await InApp.updateMany({ userId: String(userId), readAt: null }, { readAt: new Date() });
  return (res && (res.modifiedCount ?? res.nModified)) || 0;
}

export default { create, list, unreadCount, markRead, markAllRead, safeLink };

export { create, list, unreadCount, markRead, markAllRead, safeLink };
