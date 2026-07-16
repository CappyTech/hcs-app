const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/emailAdminController");

// ── Admin email dashboard (admin only) ────────────────────────────────────
router.get("/admin/emails", authService.ensureRole("admin"), ctrl.getHub);

// Catalog of email/notification types
router.get("/admin/emails/types", authService.ensureRole("admin"), ctrl.getTypes);
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
router.get("/notifications/unsubscribe", ctrl.getUnsubscribe);
router.post("/notifications/unsubscribe", ctrl.postUnsubscribe);

module.exports = router;
