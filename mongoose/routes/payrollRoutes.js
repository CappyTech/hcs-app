import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/payrollController.js';
import provider from '../controllers/payrollProviderController.js';
import staffologyPayroll from '../controllers/staffologyPayrollController.js';
import { isStaffologyMode } from '../../services/staffologyModeService.js';

// Staffology mode (Settings → Connections → Staffology, key saved and test
// passed): the pages that stay show Staffology data instead of the in-house
// engine. The engine-only pages are redirected earlier, by the gate in app.js.
const byMode = (staffology, engine) => (req, res, next) =>
  (isStaffologyMode() ? staffology : engine)(req, res, next);

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
  byMode(staffologyPayroll.renderDashboard, ctrl.renderDashboard)
);

// ── Run list ──────────────────────────────────────────────────────────────────
router.get('/payroll/runs',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  byMode(staffologyPayroll.renderRuns, ctrl.renderRunList)
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

// ── Staffology (external payroll) ─────────────────────────────────────────────
// Payroll is run in Staffology; hcs-sync copies its employees and pay runs into
// the STAFFOLOGY database. These pages compare that pay with approved
// attendance. Same access as the dashboard; linking changes an employee's
// payroll ID, so it is admin only.
router.get('/payroll/staffology',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  provider.renderComparison
);
router.get('/payroll/staffology/employees',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  provider.renderEmployees
);
// One payslip PDF, fetched live from Staffology (never stored).
router.get('/payroll/staffology/payslip/:entryUuid',
  authService.ensureGroup('payroll', 'view', 'admin', 'accountant'),
  staffologyPayroll.staffPayslip
);
router.post('/payroll/staffology/employees/:uuid/link',
  authService.ensureRole('admin'),
  provider.linkEmployee
);
// Pick-list form: the employee comes from the form (employeeUuid).
router.post('/payroll/staffology/employees/link',
  authService.ensureRole('admin'),
  provider.linkEmployee
);
// Copy every linked employee's pay rates from Staffology (also hourly, by the
// 'staffology-rate-sync' job). Admin only, like linking.
router.post('/payroll/staffology/employees/sync-rates',
  authService.ensureRole('admin'),
  provider.syncRates
);

// ── Employee payroll settings ─────────────────────────────────────────────────
router.get('/payroll/employee/:uuid',
  authService.ensureGroup('payroll', 'edit'),
  byMode(staffologyPayroll.renderEmployeePayroll, ctrl.renderEmployeePayroll)
);
router.post('/payroll/employee/:uuid',
  authService.ensureGroup('payroll', 'edit'),
  byMode(staffologyPayroll.saveEmployeePayrollId, ctrl.saveEmployeePayroll)
);

export default router;
