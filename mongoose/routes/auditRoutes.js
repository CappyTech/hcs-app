import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/auditController.js';

// The audit trail is admin-only.
router.get('/audit', authService.ensureRole('admin'), ctrl.getAuditLog);

export default router;
