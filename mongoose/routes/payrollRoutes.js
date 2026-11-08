import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/payrollController.js';

// Permission groups (accessGroupsConfig), Payroll:
//   view    — dashboard, runs, submissions log, FPS/EPS/pension downloads
//             (also the accountant, as before)
//   edit    — create and calculate runs, override an entry, employee pay
//   approve — lock a run
//   manage  — anything that leaves the app or undoes a sign-off: unlock,
//             post the KashFlow journal, submit FPS/EPS to HMRC, submit to
//             the pension provider. Admin and Director hold manage; whoever
//             locked a run can't submit it (separationOfDutiesService).
// Payroll settings and tax rates are System settings and stay admin-only.

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/payroll/dashboard',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.renderDashboard
);

// ── Run list ──────────────────────────────────────────────────────────────────
router.get('/payroll/runs',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.renderRunList
);

// ── Create new run ────────────────────────────────────────────────────────────
router.post('/payroll/runs/create',
  authService.ensureGroup('payroll', 'edit'),
  ctrl.createRun
);

// ── Run detail ────────────────────────────────────────────────────────────────
router.get('/payroll/run/:uuid',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.renderRunDetail
);

// ── Calculate / recalculate ───────────────────────────────────────────────────
router.post('/payroll/run/:uuid/calculate',
  authService.ensureGroup('payroll', 'edit'),
  ctrl.calculateRun
);

// ── Override a single entry field ─────────────────────────────────────────────
router.patch('/payroll/run/:uuid/entry/:entryUuid',
  authService.ensureGroup('payroll', 'edit'),
  ctrl.overrideEntry
);

// ── Lock / unlock ─────────────────────────────────────────────────────────────
router.post('/payroll/run/:uuid/lock',
  authService.ensureGroup('payroll', 'approve'),
  ctrl.lockRun
);
router.post('/payroll/run/:uuid/unlock',
  authService.ensureGroup('payroll', 'manage'),
  ctrl.unlockRun
);

// ── KashFlow journal posting ──────────────────────────────────────────────────
router.post('/payroll/run/:uuid/post-journal',
  authService.ensureGroup('payroll', 'manage'),
  ctrl.postJournal
);

// ── HMRC RTI ──────────────────────────────────────────────────────────────────
router.get('/payroll/run/:uuid/fps/download',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.downloadFPS
);
router.post('/payroll/run/:uuid/fps/submit',
  authService.ensureGroup('payroll', 'manage'),
  ctrl.submitFPS
);

router.get('/payroll/hmrc/eps/:year/:month/download',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.downloadEPS
);
router.post('/payroll/hmrc/eps/:year/:month/submit',
  authService.ensureGroup('payroll', 'manage'),
  ctrl.submitEPS
);

// ── HMRC submissions log ──────────────────────────────────────────────────────
router.get('/payroll/submissions',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.renderSubmissions
);

// ── People's Pension ──────────────────────────────────────────────────────────
router.get('/payroll/run/:uuid/pension/csv',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  ctrl.downloadPensionCSV
);
router.post('/payroll/run/:uuid/pension/submit',
  authService.ensureGroup('payroll', 'manage'),
  ctrl.submitPension
);

// ── Payroll settings ──────────────────────────────────────────────────────────
router.get('/settings/payroll',
  authService.ensureRole('admin'),
  ctrl.renderPayrollSettings
);
router.post('/settings/payroll',
  authService.ensureRole('admin'),
  ctrl.savePayrollSettings
);

router.get('/settings/payroll/tax-rates',
  authService.ensureRole('admin'),
  ctrl.renderTaxRates
);
router.get('/settings/payroll/tax-rates/:year',
  authService.ensureRole('admin'),
  ctrl.renderEditTaxRate
);
router.post('/settings/payroll/tax-rates/:year',
  authService.ensureRole('admin'),
  ctrl.saveEditTaxRate
);

// ── Employee payroll settings ─────────────────────────────────────────────────
router.get('/payroll/employee/:uuid',
  authService.ensureGroup('payroll', 'edit'),
  ctrl.renderEmployeePayroll
);
router.post('/payroll/employee/:uuid',
  authService.ensureGroup('payroll', 'edit'),
  ctrl.saveEmployeePayroll
);

export default router;
