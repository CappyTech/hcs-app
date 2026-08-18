/**
 * The website content editor. Admin only, twice over:
 *
 * - `routeAccess['/website']` in rolePermissionsConfig — matched by literal
 *   longest prefix, so this one entry covers every path below.
 * - `ensureRole('admin')` on each route, the same belt-and-braces as
 *   company-docs.
 *
 * The `:type` parameter is not free-form: webController resolves it through
 * webContentConfig and 404s on anything it does not name, so the generic routes
 * cannot be pointed at an arbitrary model.
 *
 * `/website/settings` is registered **before** the generic `/website/:type`
 * routes. Express matches in declaration order, and the singleton needs its own
 * handlers (no list, no create, no delete).
 */
import express from 'express';
import authService from '../../services/authService.js';
import ctrl from '../controllers/webController.js';

const router = express.Router();
const adminOnly = authService.ensureRole('admin');

// ── Site settings (singleton) ───────────────────────────────────────────────
router.get('/website/settings', adminOnly, ctrl.getSettings);
router.post('/website/settings', adminOnly, ctrl.postSettings);

// ── Media library ───────────────────────────────────────────────────────────
router.get('/website/media', adminOnly, ctrl.getMedia);
router.get('/website/media/:uuid/file', adminOnly, ctrl.getMediaFile);
// multer first, then csrfService.validate — the global CSRF middleware runs
// before a multipart body is parsed and would reject every upload.
router.post('/website/media', adminOnly, ...ctrl.postMediaUpload);
router.post('/website/media/:uuid/delete', adminOnly, ctrl.postMediaDelete);

// ── Collection types ────────────────────────────────────────────────────────
router.get('/website/:type', adminOnly, ctrl.getList);
router.get('/website/:type/create', adminOnly, ctrl.getCreate);
router.post('/website/:type', adminOnly, ctrl.postCreate);
router.get('/website/:type/:uuid/edit', adminOnly, ctrl.getEdit);
router.post('/website/:type/:uuid', adminOnly, ctrl.postEdit);
router.post('/website/:type/:uuid/publish', adminOnly, ctrl.postPublish);
router.post('/website/:type/:uuid/unpublish', adminOnly, ctrl.postUnpublish);
router.post('/website/:type/:uuid/delete', adminOnly, ctrl.postDelete);

export default router;
