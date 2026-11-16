import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/jobRegisterController.js';
import importCtrl from '../controllers/workbookImportController.js';

// Job Register: the quote/job plan of what will be in KashFlow. Commercial
// view reads it (as it reads quotes and projects); Commercial edit writes it.
// The accountant reads it alongside the KashFlow records it is checked against.
router.get(
  '/job-register',
  authService.ensureGroup([{ group: 'commercial', level: 'view' }, { group: 'finance', level: 'view' }], null, 'admin', 'accountant'),
  ctrl.getRegister,
);
router.post(
  '/job-register',
  authService.ensureGroup('commercial', 'edit', 'admin'),
  ctrl.postCreate,
);
// Import the Job Reg workbook: upload, check, import. Admin only (a bulk
// write). Before /:uuid, which would otherwise take "import" as an entry.
router.get('/job-register/import', authService.ensureRole('admin'), importCtrl.getJobRegisterUpload);
router.post('/job-register/import', authService.ensureRole('admin'), importCtrl.postJobRegisterUpload);
router.get('/job-register/import/:uuid', authService.ensureRole('admin'), importCtrl.getJobRegisterCheck);
router.post('/job-register/import/:uuid', authService.ensureRole('admin'), importCtrl.postJobRegisterImport);
// The Next buttons: show the form again with KashFlow's next number filled in.
// Before /:uuid, which would otherwise take "next" as an entry.
router.post(
  '/job-register/next',
  authService.ensureGroup('commercial', 'edit', 'admin'),
  ctrl.postFillNext,
);
router.post(
  '/job-register/:uuid/next',
  authService.ensureGroup('commercial', 'edit', 'admin'),
  ctrl.postFillNextEdit,
);
router.get(
  '/job-register/:uuid',
  authService.ensureGroup([{ group: 'commercial', level: 'view' }, { group: 'finance', level: 'view' }], null, 'admin', 'accountant'),
  ctrl.getEdit,
);
router.post(
  '/job-register/:uuid',
  authService.ensureGroup('commercial', 'edit', 'admin'),
  ctrl.postUpdate,
);

export default router;
