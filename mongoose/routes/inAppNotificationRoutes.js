import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/inAppNotificationController.js';

// In-app notifications (every signed-in person, their own only). The public
// email unsubscribe page lives under /notifications/unsubscribe in
// emailRoutes.js; nothing here uses that path.
router.get('/notifications', authService.ensureAnyRole(), ctrl.getNotifications);
router.post('/notifications/read-all', authService.ensureAnyRole(), ctrl.postMarkAllRead);
router.post('/notifications/:uuid/read', authService.ensureAnyRole(), ctrl.postMarkRead);
router.post('/notifications/:uuid/open', authService.ensureAnyRole(), ctrl.postOpen);

export default router;
