import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/ramsController.js';

// RAMS briefings (Health & Safety, phase 5c). Site Managers and Supervisors
// hold Health & Safety at edit on their own sites; the controller offers and
// accepts only approved RAMS on those sites and the people assigned to them.
// (POST /rams/brief doesn't reach the generic POST /rams/:uuid update: its
// uuid param check passes a non-UUID on.)
const HS_EDIT = [{ group: 'healthSafety', level: 'edit', project: true }];
const guard = authService.ensureGroup(HS_EDIT, null, 'admin');

router.get('/rams/brief', guard, ctrl.getBrief);
router.post('/rams/brief', guard, ctrl.postBrief);

export default router;
