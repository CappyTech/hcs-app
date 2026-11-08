import express from 'express';
const router = express.Router();
import rolesGuideController from '../controllers/rolesGuideController.js';

// Public: linked from the signed-out home page, so it must work with no
// session (listed in authService PUBLIC_PATHS). Read-only, no user data.
router.get('/roles', rolesGuideController.getRolesGuide);

export default router;
