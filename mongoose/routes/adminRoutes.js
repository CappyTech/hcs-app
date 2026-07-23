import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/adminController.js';

router.get(
  "/admin/deleted-items",
  authService.ensureRole("admin"),
  ctrl.getDeletedItems,
);

router.get(
  "/admin/ui-guidelines",
  authService.ensureRole("admin"),
  ctrl.getUiGuidelines,
);

router.get(
  "/admin/gdpr",
  authService.ensureRole("admin"),
  ctrl.getGdprOverview,
);

router.get(
  "/admin/gdpr/ropa",
  authService.ensureRole("admin"),
  ctrl.downloadRopa,
);

router.get(
  "/admin/gdpr/incident-response",
  authService.ensureRole("admin"),
  ctrl.viewIncidentResponse,
);

router.get(
  "/admin/gdpr/dpia-template",
  authService.ensureRole("admin"),
  ctrl.viewDpiaTemplate,
);

router.get(
  "/admin/jobs",
  authService.ensureRole("admin"),
  ctrl.getJobs,
);

router.get(
  "/admin/security-events",
  authService.ensureRole("admin"),
  ctrl.getSecurityEvents,
);

router.get(
  "/admin/maintenance",
  authService.ensureRole("admin"),
  ctrl.getMaintenance,
);

router.post(
  "/admin/maintenance",
  authService.ensureRole("admin"),
  ctrl.postMaintenance,
);

router.post(
  "/admin/jobs/:name/run",
  authService.ensureRole("admin"),
  ctrl.runJob,
);

export default router;
