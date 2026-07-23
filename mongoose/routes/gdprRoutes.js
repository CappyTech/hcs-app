import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/gdprController.js';

// ── User-facing routes (all authenticated users) ──────────────────────
// Note: /new must be registered before /:uuid to avoid route shadowing
router.get('/gdpr/requests/new', authService.ensureAuthenticated, ctrl.newRequestForm);
router.get('/gdpr/requests',     authService.ensureAuthenticated, ctrl.listMyRequests);
router.post('/gdpr/requests',    authService.ensureAuthenticated, ctrl.submitRequest);
router.get('/gdpr/requests/:uuid', authService.ensureAuthenticated, ctrl.getRequest);
router.post('/gdpr/requests/:uuid/withdraw', authService.ensureAuthenticated, ctrl.withdrawRequest);

// ── Admin-only routes ─────────────────────────────────────────────────
router.get('/admin/gdpr/requests', authService.ensureRole('admin'), ctrl.adminListRequests);
router.post('/admin/gdpr/requests/:uuid/review', authService.ensureRole('admin'), ctrl.adminReviewRequest);

export default router;
