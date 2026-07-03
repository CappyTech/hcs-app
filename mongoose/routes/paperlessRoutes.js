const express = require("express");
const rateLimit = require("express-rate-limit");
const { getClientIp } = require("../../services/ipService");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/paperlessController");

// Stricter rate limiter for the grab trigger (fires background API calls)
const grabLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: "Too many grab requests — please wait before triggering another.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

// Shared guard layers — authenticated + admin role + paperless department
const paperlessGuard = [
  authService.ensureAuthenticated,
  authService.ensureRole(),
  authService.ensureDepartment("paperless"),
];

router.get("/paperless/ocr", ...paperlessGuard, ctrl.listOcr);
router.get("/paperless/ocr/:paperlessId", ...paperlessGuard, ctrl.readOcr);
router.get("/paperless/ocr/:paperlessId/draft", ...paperlessGuard, ctrl.getPurchaseDraft);
router.get("/paperless/ocr/:paperlessId/match", ...paperlessGuard, ctrl.getMatchPurchase);
router.post("/paperless/ocr/:paperlessId/match", ...paperlessGuard, ctrl.postMatchPurchase);
router.post("/paperless/ocr/:paperlessId/send", ...paperlessGuard, ctrl.sendDraftToKashflow);
router.post("/paperless/ocr/:paperlessId/ingest", ...paperlessGuard, ctrl.reIngestOne);
router.post("/paperless/ocr/:paperlessId/sync-fields", ...paperlessGuard, ctrl.syncPaperlessFields);
router.post("/paperless/ocr/:paperlessId/unlink", ...paperlessGuard, ctrl.unlinkKashflow);
router.delete("/paperless/ocr/:paperlessId", ...paperlessGuard, ctrl.deleteOcrDocument);
router.post("/paperless/ocr/:paperlessId/remove", ...paperlessGuard, ctrl.removeDeletedOcrDocument);
router.get("/paperless/suppliers", ...paperlessGuard, ctrl.searchSuppliers);
router.get("/paperless/ingest", ...paperlessGuard, ctrl.listIngest);
router.post("/paperless/ingest/trigger", ...paperlessGuard, grabLimiter, ctrl.triggerGrab);
router.post("/paperless/repair-drift",    ...paperlessGuard, ctrl.repairDrift);
router.post("/paperless/resolve-numbers", ...paperlessGuard, ctrl.resolveNumbers);
router.post("/paperless/match-references", ...paperlessGuard, ctrl.matchReferences);
router.post("/paperless/clear-orphans",   ...paperlessGuard, ctrl.clearOrphans);

module.exports = router;
