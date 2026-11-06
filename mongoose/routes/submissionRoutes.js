import express from 'express';
const router = express.Router();
import path from 'path';
import authService from '../../services/authService.js';
import controller from '../controllers/submissionController.js';

// Admin only — previously had NO auth middleware
// Finance manage, which no job role holds: admin-only until the
// separation-of-duties decision (docs/PERMISSION-GROUPS.md, decision 3).
router.post(
  "/receipts/change-submission",
  authService.ensureGroup("finance", "manage"),
  controller.changeReceipts,
);
router.post(
  "/purchase/change",
  authService.ensureGroup("finance", "manage"),
  controller.changePurchases,
);

export default router;
