'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/overviewController');

router.get('/overview/fleet',
  authService.ensureRole('admin'),
  ctrl.getFleetOverview);

router.get('/overview/human',
  authService.ensureRole('admin'),
  ctrl.getHumanOverview);

router.get('/overview/finance',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.getFinanceOverview);

router.get('/overview/projects',
  authService.ensureRole('admin'),
  ctrl.getProjectsOverview);

router.post('/overview/projects/check',
  authService.ensureRole('admin'),
  ctrl.postProjectsFinancialCheck);

router.post('/overview/projects/:number/complete',
  authService.ensureRole('admin'),
  ctrl.postProjectMarkComplete);

router.get('/overview/admin',
  authService.ensureRole('admin'),
  ctrl.getAdminOverview);

router.get('/overview/documents',
  authService.ensureRole('admin'),
  ctrl.getDocumentsOverview);

router.get('/overview/subcontractors',
  authService.ensureRoles('admin', 'accountant', 'hmrc'),
  ctrl.getSubcontractorsOverview);

router.get('/overview/payroll',
  authService.ensureRoles('admin', 'accountant'),
  ctrl.getPayrollOverview);

module.exports = router;
