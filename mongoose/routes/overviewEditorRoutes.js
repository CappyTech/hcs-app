import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/overviewEditorController.js';

// Overview settings (/admin/overviews): admin only. Saves go through
// overviewConfigService's validation, so the editor can't store anything a
// page would refuse.
const admin = authService.ensureRole('admin');

router.get('/admin/overviews', admin, ctrl.getIndex);
router.post('/admin/overviews/area', admin, ctrl.postNewArea);
router.get('/admin/overviews/area/:key', admin, ctrl.getArea);
router.post('/admin/overviews/area/:key', admin, ctrl.postArea);
router.post('/admin/overviews/area/:key/reset', admin, ctrl.postAreaReset);
router.post('/admin/overviews/node', admin, ctrl.postNewNode);
router.get('/admin/overviews/node/:key', admin, ctrl.getNode);
router.post('/admin/overviews/node/:key', admin, ctrl.postNode);
router.post('/admin/overviews/node/:key/reset', admin, ctrl.postNodeReset);

export default router;
