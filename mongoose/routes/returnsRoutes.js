import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/returnsController.js';

// Monthly returns selection form
router.get(
  "/CIS/returns/form",
  authService.ensureRoles("admin", "accountant", "hmrc"),
  ctrl.renderMonthlyReturnsForm,
);

// All subcontractors: Full yearly CIS return
router.get(
  "/CIS/returns/all/:year",
  authService.ensureRoles("admin", "accountant", "hmrc"),
  ctrl.renderYearlyReturnsForAll,
);

// All subcontractors: One specific month
router.get(
  "/CIS/returns/all/:year/:month",
  authService.ensureRoles("admin", "accountant", "hmrc"),
  ctrl.renderMonthlyReturnsForAll,
);

// Single subcontractor: Full yearly CIS return (subcontractor can view own)
router.get(
  "/CIS/returns/:uuid/yearly/:year",
  authService.ensureRoles("admin", "accountant", "hmrc", "subcontractor"),
  ctrl.renderYearlyReturns,
);

// Single subcontractor: Single month (subcontractor can view own)
router.get(
  "/CIS/returns/:uuid/:year/:month",
  authService.ensureRoles("admin", "accountant", "hmrc", "subcontractor"),
  ctrl.renderMonthlyReturns,
);

export default router;
