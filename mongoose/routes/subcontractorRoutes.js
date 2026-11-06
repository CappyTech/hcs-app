import express from 'express';
const router = express.Router();
import path from 'path';
import authService from '../../services/authService.js';
import controller from '../controllers/subcontractorController.js';

// Admin only — previously had NO auth middleware
router.get(
  "/subcontractor/assign",
  authService.ensureGroup("cis", "manage"),
  controller.renderAssignForm,
);
router.post(
  "/subcontractor/assign",
  authService.ensureGroup("cis", "manage"),
  controller.assignSubcontractor,
);
router.get(
  "/supplier/change/:uuid",
  authService.ensureGroup("cis", "manage"),
  controller.renderChangeSupplierForm,
);
router.post(
  "/supplier/change/:uuid",
  authService.ensureGroup("cis", "manage"),
  controller.changeSupplier,
);

export default router;
