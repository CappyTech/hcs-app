import express from 'express';
const router = express.Router();
import path from 'path';
import authService from '../../services/authService.js';
import controller from '../controllers/subcontractorController.js';

// Admin only — previously had NO auth middleware
router.get(
  "/subcontractor/assign",
  authService.ensureRole("admin"),
  controller.renderAssignForm,
);
router.post(
  "/subcontractor/assign",
  authService.ensureRole("admin"),
  controller.assignSubcontractor,
);
router.get(
  "/supplier/change/:uuid",
  authService.ensureRole("admin"),
  controller.renderChangeSupplierForm,
);
router.post(
  "/supplier/change/:uuid",
  authService.ensureRole("admin"),
  controller.changeSupplier,
);

export default router;
