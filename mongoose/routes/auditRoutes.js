import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/auditController.js';

// The audit trail: admin, and System view (a Director). Read-only.
router.get('/audit', authService.ensureGroup('system', 'view'), ctrl.getAuditLog);

export default router;
