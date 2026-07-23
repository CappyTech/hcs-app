import express from 'express';
const router = express.Router();
import path from 'path';
import authService from '../../services/authService.js';
import controller from '../controllers/submissionController.js';

// Admin only — previously had NO auth middleware
router.post(
  "/receipts/change-submission",
  authService.ensureRole("admin"),
  controller.changeReceipts,
);
router.post(
  "/purchase/change",
  authService.ensureRole("admin"),
  controller.changePurchases,
);

export default router;
