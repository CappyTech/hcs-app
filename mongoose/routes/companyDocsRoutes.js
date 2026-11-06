import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/companyDocsController.js';

// Documents permission group: view reads letterhead and policies, edit
// changes them, approve deletes a policy.
const view = authService.ensureGroup('documents', 'view');
const edit = authService.ensureGroup('documents', 'edit');
const approve = authService.ensureGroup('documents', 'approve');

router.get('/company-docs',                        view, ctrl.getIndex);
router.get('/company-docs/letterhead',             view, ctrl.getLetterhead);
router.get('/company-docs/letterhead/logo',        view, ctrl.getLetterheadLogo);
router.post('/company-docs/letterhead',            edit, ...ctrl.postLetterhead);
router.get('/company-docs/policies',               view, ctrl.getPolicyList);
router.get('/company-docs/policies/create',        edit, ctrl.getCreatePolicy);
router.post('/company-docs/policies',              edit, ctrl.postCreatePolicy);
router.get('/company-docs/policies/:uuid/edit',    edit, ctrl.getEditPolicy);
router.post('/company-docs/policies/:uuid',        edit, ctrl.postEditPolicy);
router.post('/company-docs/policies/:uuid/delete', approve, ctrl.postDeletePolicy);
router.get('/company-docs/policies/:uuid/print',   view, ctrl.getPrintPolicy);

export default router;
