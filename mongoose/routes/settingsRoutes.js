const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const settings = require("../controllers/settingsController");
const connSettings = require("../controllers/connectionSettingsController");

// ── External connection settings (admin only) ─────────────────────────────────
router.get('/admin/connections', authService.ensureRoles('admin'), connSettings.getConnectionsHub);
router.get('/admin/connections/kashflow', authService.ensureRoles('admin'), connSettings.getKashflowSettings);
router.post('/admin/connections/kashflow', authService.ensureRoles('admin'), connSettings.postKashflowSettings);
router.get('/admin/connections/smtp', authService.ensureRoles('admin'), connSettings.getSmtpSettings);
router.post('/admin/connections/smtp', authService.ensureRoles('admin'), connSettings.postSmtpSettings);
router.get('/admin/connections/paperless', authService.ensureRoles('admin'), connSettings.getPaperlessSettings);
router.post('/admin/connections/paperless', authService.ensureRoles('admin'), connSettings.postPaperlessSettings);
router.get('/admin/connections/sms', authService.ensureRoles('admin'), connSettings.getSmsSettings);
router.post('/admin/connections/sms', authService.ensureRoles('admin'), connSettings.postSmsSettings);
router.post('/admin/connections/test/:service', authService.ensureRoles('admin'), connSettings.testConnection);

// All authenticated users can access their own profile/account
router.get(
  "/user/profile",
  authService.ensureAnyRole(),
  settings.getProfilePage,
);
router.get(
  "/user/account",
  authService.ensureAnyRole(),
  settings.getAccountPage,
);
router.post(
  "/user/account/settings",
  authService.ensureAnyRole(),
  settings.validateAccountSettings,
  settings.updateAccountSettings,
);
router.post(
  "/user/account/logout-session",
  authService.ensureAnyRole(),
  settings.logoutSession,
);
router.post(
  "/user/account/logout-all-sessions",
  authService.ensureAnyRole(),
  settings.logoutAllOtherSessions,
);
router.post(
  "/user/account/verify-totp",
  authService.ensureAnyRole(),
  settings.verifyAndEnableTotp,
);
router.post(
  "/user/account/disable-totp",
  authService.ensureAnyRole(),
  settings.disableTotp,
);
router.post(
  "/user/account/regenerate-backup-codes",
  authService.ensureAnyRole(),
  settings.regenerateBackupCodes,
);
router.post(
  "/user/account/change-password",
  authService.ensureAnyRole(),
  settings.validateChangePassword,
  settings.changePassword,
);

// ── Personal email/notification dashboard ─────────────────────────────────
router.get(
  "/user/account/settings/notifications",
  authService.ensureAnyRole(),
  settings.getNotificationsPage,
);
router.post(
  "/user/account/settings/notifications/toggle",
  authService.ensureAnyRole(),
  settings.toggleNotification,
);
router.post(
  "/user/account/settings/notifications/allow-admin",
  authService.ensureAnyRole(),
  settings.setAllowAdminEmails,
);
router.post(
  "/user/account/settings/notifications/send-test",
  authService.ensureAnyRole(),
  settings.sendTestNotification,
);
router.post(
  "/user/account/settings/notifications/rotate-token",
  authService.ensureAnyRole(),
  settings.rotateNotificationToken,
);
router.get(
  "/user/account/settings/notifications/preview/:key",
  authService.ensureAnyRole(),
  settings.previewNotification,
);

module.exports = router;
