import path from 'path';
import logger from '../../services/loggerService.js';
import inAppNotificationService from '../services/inAppNotificationService.js';

/**
 * /notifications — the signed-in person's in-app notifications.
 * Everything is scoped to req.session.user.id by inAppNotificationService.
 */

const LIST_URL = '/notifications';

export const getNotifications = async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const data = await inAppNotificationService.list(userId, { page: req.query.page });
    res.render(path.join('tailwindcss', 'notifications', 'index'), {
      title: 'Notifications',
      ...data,
    });
  } catch (error) {
    logger.error(`Error loading notifications: ${error.message}`);
    next(error);
  }
};

// Mark one read and stay on the list (keeps the page the person was on).
export const postMarkRead = async (req, res) => {
  const page = Number(req.body.page) > 1 ? `?page=${Number(req.body.page)}` : '';
  try {
    const doc = await inAppNotificationService.markRead(req.session.user.id, req.params.uuid);
    if (!doc) req.flash('error', 'That notification was not found.');
  } catch (error) {
    logger.error(`Error marking notification read: ${error.message}`);
    req.flash('error', 'Could not mark the notification as read.');
  }
  res.redirect(LIST_URL + page);
};

// Open: mark it read, then go where it points (a same-site path only).
export const postOpen = async (req, res) => {
  try {
    const doc = await inAppNotificationService.markRead(req.session.user.id, req.params.uuid);
    const link = doc && inAppNotificationService.safeLink(doc.link);
    if (link) return res.redirect(link);
    if (!doc) req.flash('error', 'That notification was not found.');
  } catch (error) {
    logger.error(`Error opening notification: ${error.message}`);
    req.flash('error', 'Could not open the notification.');
  }
  res.redirect(LIST_URL);
};

export const postMarkAllRead = async (req, res) => {
  try {
    const count = await inAppNotificationService.markAllRead(req.session.user.id);
    req.flash('success', count ? `Marked ${count} notification${count === 1 ? '' : 's'} as read.` : 'Nothing unread.');
  } catch (error) {
    logger.error(`Error marking all notifications read: ${error.message}`);
    req.flash('error', 'Could not mark notifications as read.');
  }
  res.redirect(LIST_URL);
};

export default { getNotifications, postMarkRead, postOpen, postMarkAllRead };
