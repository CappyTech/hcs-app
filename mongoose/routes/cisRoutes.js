import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/cisController.js';

router.get(
  "/CIS/Dashboard/:year/:month",
  authService.ensureGroup("cis", "approve", "admin", "accountant", "hmrc"),
  ctrl.renderCISDashboardMongo,
);
router.get(
  "/CIS/Dashboard/",
  authService.ensureGroup("cis", "approve", "admin", "accountant", "hmrc"),
  ctrl.redirectCIS,
);

export default router;
