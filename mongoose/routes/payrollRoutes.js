'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/payrollController');

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/payroll',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.renderDashboard
);

// ── Run list ──────────────────────────────────────────────────────────────────
router.get('/payroll/runs',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.renderRunList
);

// ── Create new run ────────────────────────────────────────────────────────────
router.post('/payroll/runs/create',
  authService.ensureRole('admin'),
  ctrl.createRun
);

// ── Run detail ────────────────────────────────────────────────────────────────
router.get('/payroll/run/:uuid',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.renderRunDetail
);

// ── Calculate / recalculate ───────────────────────────────────────────────────
router.post('/payroll/run/:uuid/calculate',
  authService.ensureRole('admin'),
  ctrl.calculateRun
);

// ── Override a single entry field ─────────────────────────────────────────────
router.patch('/payroll/run/:uuid/entry/:entryUuid',
  authService.ensureRole('admin'),
  ctrl.overrideEntry
);

// ── Lock / unlock ─────────────────────────────────────────────────────────────
router.post('/payroll/run/:uuid/lock',
  authService.ensureRole('admin'),
  ctrl.lockRun
);
router.post('/payroll/run/:uuid/unlock',
  authService.ensureRole('admin'),
  ctrl.unlockRun
);

// ── KashFlow journal posting ──────────────────────────────────────────────────
router.post('/payroll/run/:uuid/post-journal',
  authService.ensureRole('admin'),
  ctrl.postJournal
);

// ── HMRC RTI ──────────────────────────────────────────────────────────────────
router.get('/payroll/run/:uuid/fps/download',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.downloadFPS
);
router.post('/payroll/run/:uuid/fps/submit',
  authService.ensureRole('admin'),
  ctrl.submitFPS
);

router.get('/payroll/hmrc/eps/:year/:month/download',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.downloadEPS
);
router.post('/payroll/hmrc/eps/:year/:month/submit',
  authService.ensureRole('admin'),
  ctrl.submitEPS
);

// ── HMRC submissions log ──────────────────────────────────────────────────────
router.get('/payroll/submissions',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.renderSubmissions
);

// ── People's Pension ──────────────────────────────────────────────────────────
router.get('/payroll/run/:uuid/pension/csv',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.downloadPensionCSV
);
router.post('/payroll/run/:uuid/pension/submit',
  authService.ensureRole('admin'),
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
  authService.ensureRole('admin'),
  ctrl.renderEmployeePayroll
);
router.post('/payroll/employee/:uuid',
  authService.ensureRole('admin'),
  ctrl.saveEmployeePayroll
);

module.exports = router;
