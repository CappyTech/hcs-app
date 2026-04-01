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

router.get('/overview/admin',
  authService.ensureRole('admin'),
  ctrl.getAdminOverview);

router.get('/overview/documents',
  authService.ensureRole('admin'),
  ctrl.getDocumentsOverview);

router.get('/overview/subcontractors',
  authService.ensureRoles('admin', 'accountant', 'hmrc'),
  ctrl.getSubcontractorsOverview);

module.exports = router;
