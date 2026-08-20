import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import settings from '../controllers/settingsController.js';
import connSettings from '../controllers/connectionSettingsController.js';
import appConfig from '../controllers/appConfigController.js';

// ── Configuration (admin only) ────────────────────────────────────────────────
// Every page is generated from configRegistry; there is no per-group route to
// add when a setting is introduced.
router.get('/admin/config', authService.ensureRoles('admin'), appConfig.getHub);
router.get('/admin/config/:group', authService.ensureRoles('admin'), appConfig.getGroup);
router.post('/admin/config/:group', authService.ensureRoles('admin'), appConfig.postGroup);
router.post('/admin/config/:group/adopt', authService.ensureRoles('admin'), appConfig.postAdopt);
router.post('/admin/config/:group/revert', authService.ensureRoles('admin'), appConfig.postRevert);

// The connection tester stays where it was — the settings pages POST to it.
router.post('/admin/connections/test/:service', authService.ensureRoles('admin'), connSettings.testConnection);

// Old per-service URLs, kept as redirects: they are in bookmarks and in the
// admin menu, and a 404 on a settings page reads as "the feature is gone".
const LEGACY_GROUPS = { kashflow: 'kashflow', smtp: 'smtp', paperless: 'paperless', sms: 'sms' };
router.get('/admin/connections', authService.ensureRoles('admin'), (_req, res) => res.redirect('/admin/config'));
for (const [legacy, group] of Object.entries(LEGACY_GROUPS)) {
  router.get(`/admin/connections/${legacy}`, authService.ensureRoles('admin'), (_req, res) =>
    res.redirect(`/admin/config/${group}`));
  router.post(`/admin/connections/${legacy}`, authService.ensureRoles('admin'), (_req, res) =>
    res.redirect(307, `/admin/config/${group}`));
}

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

export default router;
