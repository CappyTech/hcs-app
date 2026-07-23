import express from 'express';
import rateLimit from 'express-rate-limit';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/emailAdminController.js';

// The unsubscribe endpoint is public (token-authorised, no login). A dedicated
// tight per-IP limiter blocks token-guessing and abuse on top of the global
// limiter. GET (the read-only confirmation page) is allowed more headroom than
// the mutating POST.
const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later.",
});

// ── Admin email dashboard (admin only) ────────────────────────────────────
router.get("/admin/emails", authService.ensureRole("admin"), ctrl.getHub);

// Unsubscribe-link rotation controls
router.post("/admin/emails/rotation", authService.ensureRole("admin"), ctrl.postRotationSettings);
router.post("/admin/emails/rotate-now", authService.ensureRole("admin"), ctrl.postRotateNow);

// Global email header & footer branding
router.get("/admin/emails/branding", authService.ensureRole("admin"), ctrl.getBranding);
router.post("/admin/emails/branding", authService.ensureRole("admin"), ctrl.postBranding);

// Catalog of email/notification types
router.get("/admin/emails/types", authService.ensureRole("admin"), ctrl.getTypes);
router.get("/admin/emails/types/:key/preview", authService.ensureRole("admin"), ctrl.getTypePreview);
router.post("/admin/emails/types", authService.ensureRole("admin"), ctrl.validateType, ctrl.postCreateType);
router.post("/admin/emails/types/:key", authService.ensureRole("admin"), ctrl.validateType, ctrl.postUpdateType);
router.post("/admin/emails/types/:key/toggle", authService.ensureRole("admin"), ctrl.postToggleType);
router.post("/admin/emails/types/:key/delete", authService.ensureRole("admin"), ctrl.postDeleteType);

// Compose & send
router.get("/admin/emails/compose", authService.ensureRole("admin"), ctrl.getCompose);
router.post("/admin/emails/compose", authService.ensureRole("admin"), ctrl.validateCompose, ctrl.postCompose);

// Outbox
router.get("/admin/emails/outbox", authService.ensureRole("admin"), ctrl.getOutbox);
router.post("/admin/emails/outbox/:uuid/resend", authService.ensureRole("admin"), ctrl.postResend);
router.post("/admin/emails/outbox/:uuid/cancel", authService.ensureRole("admin"), ctrl.postCancel);

// ── Public token-scoped unsubscribe (no login) ────────────────────────────
// GET is read-only (renders a confirmation page); POST performs the change.
router.get("/notifications/unsubscribe", unsubscribeLimiter, ctrl.getUnsubscribe);
router.post("/notifications/unsubscribe", unsubscribeLimiter, ctrl.postUnsubscribe);

export default router;
