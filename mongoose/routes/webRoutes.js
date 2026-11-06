/**
 * The website content editor. Guarded twice over:
 *
 * - `routeAccess['/website']` in rolePermissionsConfig — matched by literal
 *   longest prefix, so this one entry covers every path below. The Website
 *   permission group adds the job roles that hold it.
 * - an `ensureGroup('website', level)` on each route: edit drafts content,
 *   approve publishes, unpublishes and deletes, manage changes the site
 *   settings (no job role holds manage, so settings stay admin-only).
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
const edit = authService.ensureGroup('website', 'edit');
const approve = authService.ensureGroup('website', 'approve');
const manage = authService.ensureGroup('website', 'manage');

// ── Site settings (singleton) ───────────────────────────────────────────────
router.get('/website/settings', manage, ctrl.getSettings);
router.post('/website/settings', manage, ctrl.postSettings);

// ── Media library ───────────────────────────────────────────────────────────
router.get('/website/media', edit, ctrl.getMedia);
router.get('/website/media/:uuid/file', edit, ctrl.getMediaFile);
// multer first, then csrfService.validate — the global CSRF middleware runs
// before a multipart body is parsed and would reject every upload. The upload
// and replace routes are multipart; update (alt text) and delete are plain
// urlencoded POSTs the global CSRF middleware already covers.
router.post('/website/media', edit, ...ctrl.postMediaUpload);
router.post('/website/media/:uuid', edit, ctrl.postMediaUpdate);
router.post('/website/media/:uuid/replace', edit, ...ctrl.postMediaReplace);
router.post('/website/media/:uuid/delete', approve, ctrl.postMediaDelete);

// ── Collection types ────────────────────────────────────────────────────────
router.get('/website/:type', edit, ctrl.getList);
router.get('/website/:type/create', edit, ctrl.getCreate);
router.post('/website/:type', edit, ctrl.postCreate);
router.get('/website/:type/:uuid/edit', edit, ctrl.getEdit);
router.post('/website/:type/:uuid', edit, ctrl.postEdit);
router.post('/website/:type/:uuid/publish', approve, ctrl.postPublish);
router.post('/website/:type/:uuid/unpublish', approve, ctrl.postUnpublish);
router.post('/website/:type/:uuid/delete', approve, ctrl.postDelete);

export default router;
