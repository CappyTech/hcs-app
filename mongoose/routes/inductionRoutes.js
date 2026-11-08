import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/inductionController.js';

// Record a site induction (Health & Safety, phase 5b). Site Managers and
// Supervisors hold Health & Safety at edit on their own sites; the controller
// offers and accepts only those contracts and the people assigned to them.
const HS_EDIT = [{ group: 'healthSafety', level: 'edit', project: true }];
const guard = authService.ensureGroup(HS_EDIT, null, 'admin');

router.get('/inductions/record', guard, ctrl.getRecord);
router.post('/inductions/record', guard, ctrl.postRecord);

export default router;
