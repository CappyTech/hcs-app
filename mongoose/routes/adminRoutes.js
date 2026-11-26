import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/adminController.js';
import userRolesCtrl from '../controllers/userRolesController.js';
import signInSecurityCtrl from '../controllers/userSignInSecurityController.js';
import brandingCtrl from '../controllers/brandingController.js';

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

// Read-only: admin, and System view (a Director)
router.get(
  "/admin/security-events",
  authService.ensureGroup("system", "view"),
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

// Branding: the app icon. The colour is a setting on Configuration → Appearance.
router.get(
  "/admin/branding",
  authService.ensureRole("admin"),
  brandingCtrl.getBranding,
);

router.post(
  "/admin/branding/icon",
  authService.ensureRole("admin"),
  ...brandingCtrl.postIcon,
);

router.post(
  "/admin/branding/icon/remove",
  authService.ensureRole("admin"),
  brandingCtrl.postRemoveIcon,
);

router.post(
  "/admin/jobs/:name/run",
  authService.ensureRole("admin"),
  ctrl.runJob,
);

// Job roles (user.roles[]) — the only place they change.
router.post(
  "/admin/users/:uuid/roles",
  authService.ensureRole("admin"),
  userRolesCtrl.postUserRoles,
);

// Clear a person's authenticator app and/or passkeys (lost device).
router.post(
  "/admin/users/:uuid/clear-2fa",
  authService.ensureRole("admin"),
  signInSecurityCtrl.postClearTwoFactor,
);

export default router;
