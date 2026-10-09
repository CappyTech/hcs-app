import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/homeLayoutController.js';

// Home page layout. Anyone signed in may customise their own home; role
// defaults are part of Overview settings and admin only.
const signedIn = authService.ensureAuthenticated;
const admin = authService.ensureRole('admin');

router.get('/home/customise', signedIn, ctrl.getCustomise);
router.post('/home/customise', signedIn, ctrl.postCustomise);
router.post('/home/customise/reset', signedIn, ctrl.postReset);
router.get('/admin/overviews/home/:role', admin, ctrl.getRoleDefault);
router.post('/admin/overviews/home/:role', admin, ctrl.postRoleDefault);
router.post('/admin/overviews/home/:role/reset', admin, ctrl.postRoleReset);

export default router;
