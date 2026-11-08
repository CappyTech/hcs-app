import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/jobRoleEditorController.js';

// Job role editor (/admin/job-roles): admin only. Saves go through
// jobRoleConfigService's validation and apply straight away.
const admin = authService.ensureRole('admin');

router.get('/admin/job-roles', admin, ctrl.getIndex);
router.post('/admin/job-roles', admin, ctrl.postNew);
router.get('/admin/job-roles/:slug', admin, ctrl.getRole);
router.post('/admin/job-roles/:slug', admin, ctrl.postRole);
router.post('/admin/job-roles/:slug/reset', admin, ctrl.postReset);

export default router;
