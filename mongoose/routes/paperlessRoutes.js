import express from 'express';
import rateLimit from 'express-rate-limit';
import { getClientIp } from '../../services/ipService.js';
const router = express.Router();
import authService from '../../services/authService.js';
import ctrl from '../controllers/paperlessController.js';
import webhookCtrl from '../controllers/paperlessWebhookController.js';
import queueCtrl from '../controllers/documentQueueController.js';
import typeCtrl from '../controllers/documentTypeController.js';
import entryCtrl from '../controllers/documentEntryController.js';
import readingCtrl from '../controllers/documentReadingController.js';
import shadowCtrl from '../controllers/shadowReportController.js';
import mailRuleCtrl from '../controllers/mailRuleController.js';

// Machine-to-machine: Paperless's "Document added" webhook. No session or CSRF
// token (both exempted for this path); it authenticates with the shared secret.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  message: { ok: false, error: 'Too many requests.' },
});

// Stricter rate limiter for the grab trigger (fires background API calls)
const grabLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: "Too many grab requests — please wait before triggering another.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

// Guard layers: authenticated + the Documents permission group at a level +
// the documents department. Levels (accessGroupsConfig, Documents):
//   view    — the queues, documents, files and reading reports
//   edit    — data entry, and setting a document's type, supplier and flags
//   approve — reopen a finished entry, link a document to a KashFlow purchase
//   manage  — anything that writes to KashFlow (send, create a supplier),
//             sends email (resend invoice), or repairs, re-ingests, unlinks
//             or deletes. Admin and Director hold manage; whoever saved an
//             entry can't send it themselves (separationOfDutiesService).
const docs = (level) => [
  authService.ensureAuthenticated,
  authService.ensureGroup("documents", level),
  authService.ensureDepartment("documents"),
];

router.post("/api/paperless/webhook", webhookLimiter, webhookCtrl.documentAdded);

router.get("/paperless/shadow-report", ...docs("view"), shadowCtrl.getShadowReport);
// Where to email each kind of document. Same access as the other Paperless
// pages; canOpenGuide in mailRuleController mirrors this guard for links to it.
router.get("/paperless/mail-rules", ...docs("view"), mailRuleCtrl.getGuide);
router.get("/paperless/queues", ...docs("view"), queueCtrl.getQueueHub);
router.get("/paperless/queues/:queue", ...docs("view"), queueCtrl.getQueue);

router.get("/paperless/ocr/:paperlessId/entry", ...docs("edit"), entryCtrl.getEntry);
router.post("/paperless/ocr/:paperlessId/entry", ...docs("edit"), entryCtrl.postEntry);
router.post("/paperless/ocr/:paperlessId/credit-note", ...docs("edit"), entryCtrl.postCreditNote);
router.post("/paperless/ocr/:paperlessId/not-for-kashflow", ...docs("edit"), entryCtrl.postNotForKashflow);
router.post("/paperless/ocr/:paperlessId/reopen", ...docs("approve"), entryCtrl.postReopen);
router.post("/paperless/ocr/:paperlessId/resend-invoice", ...docs("manage"), entryCtrl.postResendInvoice);
router.post("/paperless/ocr/:paperlessId/reviewed", ...docs("edit"), entryCtrl.postReviewed);
router.post("/paperless/ocr/:paperlessId/statement-check", ...docs("edit"), entryCtrl.postStatementCheck);
router.post("/paperless/ocr/:paperlessId/supplier", ...docs("edit"), entryCtrl.postSupplier);
router.post("/paperless/ocr/:paperlessId/type", ...docs("edit"), typeCtrl.postType);
router.post("/paperless/ocr/:paperlessId/type-confirmed", ...docs("edit"), typeCtrl.postTypeConfirmed);
router.get("/paperless/ocr/:paperlessId/file", ...docs("view"), entryCtrl.getFile);
router.get("/paperless/ocr/:paperlessId/insights", ...docs("view"), readingCtrl.getInsights);
router.post("/paperless/ocr/:paperlessId/read", ...docs("edit"), readingCtrl.postRead);
router.post("/paperless/ocr/:paperlessId/reprocess", ...docs("edit"), readingCtrl.postReprocess);
router.get("/paperless/ocr/:paperlessId/reading-fixture", ...docs("manage"), readingCtrl.getFixture);
router.get("/paperless/reading", ...docs("view"), readingCtrl.getReport);
router.get("/paperless/reading/supplier/:correspondentId", ...docs("view"), readingCtrl.getSupplier);
router.post("/paperless/reading/supplier/:correspondentId/teach", ...docs("edit"), readingCtrl.postTeach);
router.post("/paperless/reading/supplier/:correspondentId/forget", ...docs("edit"), readingCtrl.postForget);
router.post("/paperless/reading/supplier/:correspondentId/labels", ...docs("edit"), readingCtrl.postLabels);

router.get("/paperless/ocr", ...docs("view"), ctrl.listOcr);
router.get("/paperless/ocr/:paperlessId", ...docs("view"), ctrl.readOcr);
router.get("/paperless/ocr/:paperlessId/draft", ...docs("manage"), ctrl.getPurchaseDraft);
router.get("/paperless/ocr/:paperlessId/match", ...docs("approve"), ctrl.getMatchPurchase);
router.post("/paperless/ocr/:paperlessId/match", ...docs("approve"), ctrl.postMatchPurchase);
router.post("/paperless/ocr/:paperlessId/send", ...docs("manage"), ctrl.sendDraftToKashflow);
router.post("/paperless/ocr/:paperlessId/draft/extra-lines", ...docs("manage"), ctrl.saveDraftExtraLines);
router.post("/paperless/ocr/:paperlessId/ingest", ...docs("manage"), ctrl.reIngestOne);
router.post("/paperless/ocr/:paperlessId/sync-fields", ...docs("manage"), ctrl.syncPaperlessFields);
router.post("/paperless/ocr/:paperlessId/unlink", ...docs("manage"), ctrl.unlinkKashflow);
router.post("/paperless/ocr/:paperlessId/reassign", ...docs("manage"), ctrl.reassignPaperlessDocument);
router.delete("/paperless/ocr/:paperlessId", ...docs("manage"), ctrl.deleteOcrDocument);
router.post("/paperless/ocr/:paperlessId/remove", ...docs("manage"), ctrl.removeDeletedOcrDocument);
router.get("/paperless/suppliers", ...docs("view"), ctrl.searchSuppliers);
router.post("/paperless/suppliers", ...docs("manage"), ctrl.createSupplier);
router.get("/paperless/ingest", ...docs("view"), ctrl.listIngest);
router.post("/paperless/ingest/trigger", ...docs("manage"), grabLimiter, ctrl.triggerGrab);
router.post("/paperless/repair-drift", ...docs("manage"), ctrl.repairDrift);
router.post("/paperless/resolve-numbers", ...docs("manage"), ctrl.resolveNumbers);
router.post("/paperless/match-references", ...docs("manage"), ctrl.matchReferences);
router.post("/paperless/clear-orphans", ...docs("manage"), ctrl.clearOrphans);

export default router;
