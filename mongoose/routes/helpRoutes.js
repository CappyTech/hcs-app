import express from 'express';
const router  = express.Router();
import authService from '../../services/authService.js';
import helpController from '../controllers/helpController.js';

router.get('/help', authService.ensureAnyRole(), helpController.getHelp);
router.get('/help/api', authService.ensureRole('admin'), helpController.getApiDocs);

export default router;
