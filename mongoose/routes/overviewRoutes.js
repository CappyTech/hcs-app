import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/overviewController.js';

router.get('/overview/fleet',
  authService.ensureRole('admin'),
  ctrl.getFleetOverview);

router.get('/overview/human',
  authService.ensureRole('admin'),
  ctrl.getHumanOverview);

router.get('/overview/holiday',
  authService.ensureRole('admin'),
  ctrl.getHolidayOverview);

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

router.get('/overview/policies',
  authService.ensureRole('admin'),
  ctrl.getPoliciesOverview);

export default router;
