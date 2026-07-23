// NOTE: Statement document type handler implemented.
//
// Paperless setup required:
//   - Document type: { name: "statement" }
//   - Reuses existing custom field: "Invoice Number" (fieldId 1) — on statements
//     this contains a comma-separated list of invoice numbers
//     (e.g. "INV-19982, INV-20001, INV-20015").
//
// hcs-app implementation (attendanceServicesMongoose.fetchStatementsForWeek):
//   - Queries OcrDocument where documentType.name === "statement" modified this week.
//   - Parses "Invoice Number" custom field as comma-separated, looks up matching REST purchases.
//   - Displayed as a separate "Statements" section on weekly payroll.

import path from 'path';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import kfSession from '../../services/kashflowSessionService.js';
const kfAxios = kfSession.kfAxios;
import axios from 'axios'; // non-KashFlow requests (Paperless-ngx etc.)
const {
  grabPaperlessOCR,
  ingestOnePaperlessDoc,
  isGrabRunning,
} = __grabServicePaperless;
const {
  buildPurchaseDraftFromOcr,
  buildPurchaseDraftById,
  buildKashFlowPayloadFromDraft,
  defaultMap,
} = __purchaseDraftService;
const {
  updatePaperlessWithKashFlowInfo,
  updatePaperlessDocumentTags,
  clearPaperlessKashFlowFields,
} = __paperlessUpdateService;
import __paperlessClient from '../services/paperless/paperlessClient.js';
const { warmCfCache } = __paperlessClient;
import kfSendClaim from '../services/paperless/kashflowSendClaimService.js';
import __grabServicePaperless from '../services/grabServicePaperless.js';
import __purchaseDraftService from '../services/paperless/purchaseDraftService.js';
import __paperlessUpdateService from '../services/paperless/paperlessUpdateService.js';
import __kashflowSessionService from '../../services/kashflowSessionService.js';
import kfVat from '../../services/kashflowVatService.js';
import __paperlessClient_ from '../services/paperless/paperlessClient.js';
import __ocrOrphanService from '../services/ocrOrphanService.js';

// Helpers

/** List OCR docs (PAPERLESS DB) */
export const listOcr = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;

    // Filters
    const q = (req.query.q || "").trim();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize || "25", 10), 1),
      200,
    );
    const tagParam = String(req.query.tag || "")
      .trim()
      .toLowerCase();
    const onlyDone =
      ["1", "true", "on", "yes"].includes(
        String(req.query.done || "").toLowerCase(),
      ) || tagParam === "data-entry-done";
    const onlyUnlinked = ["1", "true", "on", "yes"].includes(
      String(req.query.unlinked || "").toLowerCase(),
    );
    const noKfNumber = ["1", "true", "on", "yes"].includes(
      String(req.query.noKfNumber || "").toLowerCase(),
    );

    // Initial-entry redirect: append autoIngest=1 once to kick off background ingest
    if (typeof req.query.autoIngest === "undefined") {
      const url = new URL(
        `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      );
      url.searchParams.set("autoIngest", "1");
      // Preserve existing filters
      if (q) url.searchParams.set("q", q);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));
      if (onlyDone) url.searchParams.set("done", "1");
      if (tagParam) url.searchParams.set("tag", tagParam);
      if (onlyUnlinked) url.searchParams.set("unlinked", "1");
      if (noKfNumber) url.searchParams.set("noKfNumber", "1");
      return res.redirect(url.pathname + "?" + url.searchParams.toString());
    }

    const filter = {};
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { title: new RegExp(safe, "i") },
        { ocrText: new RegExp(safe, "i") },
        { "correspondent.name": new RegExp(q, "i") },
        { "documentType.name": new RegExp(q, "i") },
      ];
    }

    // Optional filter: only documents tagged as data-entry-done
    if (onlyDone) {
      const r = new RegExp("^\\s*data[-_\\s]?entry[-_\\s]?done\\s*$", "i");
      const tagCond = {
        $or: [
          { "tags.name": r },
          { "tags.Name": r },
          // For string tags array
          { tags: { $elemMatch: { $regex: r } } },
        ],
      };
      filter.$and = filter.$and || [];
      filter.$and.push(tagCond);
    } else if (tagParam) {
      // Generic tag filter: match documents that have the given tag by name
      const safe = tagParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const r = new RegExp("^\\s*" + safe + "\\s*$", "i");
      const tagCond = {
        $or: [
          { "tags.name": r },
          { "tags.Name": r },
          { tags: { $elemMatch: { $regex: r } } },
        ],
      };
      filter.$and = filter.$and || [];
      filter.$and.push(tagCond);
    }

    // Optional filter: only documents with no KashFlow link
    if (onlyUnlinked) {
      filter.kashflowPurchaseId = null;
    }

    // Optional filter: only documents with no KashFlow purchase number recorded
    if (noKfNumber) {
      filter.kashflowPurchaseNumber = null;
    }

    const total = await OcrDocument.countDocuments(filter);
    const items = await OcrDocument.find(filter)
      .sort({ paperlessId: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    // Auto-ingest: trigger only when explicitly requested via query to avoid reload loops
    const autoIngest = String(req.query.autoIngest || "").trim() === "1";
    let startedBgIngest = false;
    if (autoIngest) {
      startedBgIngest = true;
      (async () => {
        try {
          const ingestPageSize = parseInt(
            process.env.PAPERLESS_PAGE_SIZE || "25",
            10,
          );
          const ingestConcurrency = parseInt(
            process.env.PAPERLESS_CONCURRENCY || "3",
            10,
          );
          await grabPaperlessOCR({
            since: null,
            query: q || null,
            pageSize: ingestPageSize,
            concurrency: ingestConcurrency,
          });
        } catch (e) {
          logger.warn(
            "Background grabPaperlessOCR (list page) failed: " + e.message,
          );
        }
      })();
    }

    res.render(path.join("tailwindcss", "paperless", "list"), {
      title: "Paperless OCR Documents",
      q,
      page,
      pageSize,
      total,
      done: onlyDone,
      tag: tagParam || null,
      unlinked: onlyUnlinked,
      noKfNumber,
      items,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      startedBgIngest,
    });
  } catch (err) {
    next(err);
  }
};

/** Read one OCR doc */
export const readOcr = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument, OcrDocumentIngest } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);

    const doc = await OcrDocument.findOne({ paperlessId }).lean();
    const ingest = await OcrDocumentIngest.findOne({ paperlessId }).lean();

    if (!doc)
      return res
        .status(404)
        .render("error", { message: "OCR document not found." });

    // Cross-check: compare MongoDB kashflowPurchaseId against the Paperless-cached custom field
    const cfKfIdEntry = (doc.customFields || []).find(
      (cf) => String(cf.fieldName || '').toLowerCase() === 'kashflow purchase id',
    );
    const cfKashflowPurchaseId = cfKfIdEntry?.value ?? null;
    const hasDrift = (
      (doc.kashflowPurchaseId != null && (cfKashflowPurchaseId == null || cfKashflowPurchaseId === '')) ||
      (doc.kashflowPurchaseId == null && cfKashflowPurchaseId != null && cfKashflowPurchaseId !== '')
    );

    // If the ingest record is in error state (e.g. 404 / deleted from Paperless), check
    // whether a document with the same content hash exists under a different Paperless ID.
    // This catches the common case where a document was deleted and re-uploaded.
    let hashDuplicate = null;
    if (ingest?.status === 'error' && ingest?.lastContentHash) {
      hashDuplicate = await OcrDocumentIngest.findOne({
        lastContentHash: ingest.lastContentHash,
        paperlessId: { $ne: paperlessId },
        status: { $ne: 'error' },
      }).select('paperlessId').lean();
    }

    res.render(path.join("tailwindcss", "paperless", "read"), {
      title: doc.title || `Doc #${paperlessId}`,
      doc,
      ingest,
      hasDrift,
      cfKashflowPurchaseId,
      hashDuplicate,
    });
  } catch (err) {
    next(err);
  }
};

/** List ingest tracker with filters */
export const listIngest = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocumentIngest } = mdb.PAPERLESS;

    const status = (req.query.status || "").trim();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize || "25", 10), 1),
      200,
    );
    const asJson = String(req.query.json || "").trim() === "1";

    const filter = {};
    if (status) filter.status = status;

    const total = await OcrDocumentIngest.countDocuments(filter);

    const items = await OcrDocumentIngest.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    // Optional JSON mode for lightweight status polling
    if (asJson) {
      const running = isGrabRunning();
      return res.json({ running, runningCount: running ? 1 : 0, total });
    }

    res.render(path.join("tailwindcss", "paperless", "ingest"), {
      title: "Paperless Ingest Tracker",
      status,
      page,
      pageSize,
      total,
      items,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    next(err);
  }
};

/** Trigger a background grab (manual) */
export const triggerGrab = async (req, res, next) => {
  try {
    let since = (req.body.since || "").trim() || null;
    // Normalize 'none'/'null'/'invalid' or non-date inputs to null to avoid 400s from API params
    if (since) {
      const s = since.toLowerCase();
      const invalidTokens = new Set(["none", "null", "invalid", "n/a", "na"]);
      const asDate = Date.parse(since);
      if (invalidTokens.has(s) || isNaN(asDate)) {
        since = null;
      }
    }
    const query = (req.body.query || "").trim() || null;
    const pageSize = parseInt(
      req.body.pageSize || process.env.PAPERLESS_PAGE_SIZE || "50",
      10,
    );
    const concurrency = parseInt(
      req.body.concurrency || process.env.PAPERLESS_CONCURRENCY || "5",
      10,
    );

    const result = await grabPaperlessOCR({
      since,
      query,
      pageSize,
      concurrency,
    });
    req.flash(
      "success",
      `Grab complete: processed=${result.processed}, skipped=${result.skipped}, failed=${result.failed}`,
    );
    res.redirect("/paperless/ingest");
  } catch (err) {
    logger.error("Trigger grab error:", err);
    req.flash("error", `Grab failed: ${err.message}`);
    res.redirect("/paperless/ingest");
  }
};

/** Render the draft page for creating a purchase from an OCR document */
export const getPurchaseDraft = async (req, res, next) => {
  try {
    await mdb.connect();
    const paperlessId = parseInt(req.params.paperlessId, 10);
    const { OcrDocument } = mdb.PAPERLESS;
    const Supplier = mdb.REST && mdb.REST.supplier;
    const doc = await OcrDocument.findOne({ paperlessId }).lean();
    if (!doc)
      return res
        .status(404)
        .render("error", { message: "OCR document not found." });
    const draft = await buildPurchaseDraftById(paperlessId);

    // Determine source field names for key draft values to aid debugging/visibility
    const norm = (s) =>
      String(s || "")
        .trim()
        .toLowerCase();
    const normKey = (s) => norm(s).replace(/[^a-z0-9]+/g, "");
    const cf = Array.isArray(doc?.customFields) ? doc.customFields : [];
    const cfEntries = cf
      .filter((c) => c && c.fieldName)
      .map((c) => ({
        original: String(c.fieldName),
        norm: norm(c.fieldName),
        key: normKey(c.fieldName),
      }));
    const pickSource = (names) => {
      const nameList = Array.isArray(names) ? names : [];
      const wanted = new Set(nameList.map(norm));
      const wantedKeys = new Set(nameList.map(normKey));
      // Pass 1: exact normalized
      for (const e of cfEntries) {
        if (wanted.has(e.norm)) return e.original;
      }
      // Pass 2: key-normalized
      for (const e of cfEntries) {
        if (wantedKeys.has(e.key)) return e.original;
      }
      // Pass 3: prefix
      for (const e of cfEntries) {
        for (const w of wantedKeys) {
          if (w && e.key.startsWith(w)) return e.original;
        }
      }
      return null;
    };
    const sources = {
      SupplierReferenceSource: pickSource(defaultMap.SupplierReference),
      IssuedDateSource: pickSource(defaultMap.IssuedDate),
      DueDateSource: pickSource(defaultMap.DueDate),
      NetAmountSource: pickSource(defaultMap.NetAmount),
      VATAmountSource: pickSource(defaultMap.VATAmount),
      GrossAmountSource: pickSource(defaultMap.GrossAmount),
    };

    // Supplier suggestions (prefill) and best guess
    let suppliers = [];
    let selectedSupplier = null;
    if (Supplier) {
      const qName = (
        draft.SupplierName ||
        doc?.correspondent?.name ||
        ""
      ).trim();
      if (qName) {
        const safe = qName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        suppliers = await Supplier.find({
          $or: [
            { Name: new RegExp(safe, "i") },
            { Code: new RegExp(safe, "i") },
          ],
        })
          .select("uuid Id Code Name IsArchived DefaultNominalCode")
          .limit(10)
          .lean();
        // exact case-insensitive match preference
        const nameLower = qName.toLowerCase();
        selectedSupplier =
          suppliers.find(
            (s) =>
              (s.Name || "").toLowerCase() === nameLower ||
              (s.Code || "").toLowerCase() === nameLower,
          ) || null;
      } else {
        suppliers = await Supplier.find({})
          .select("uuid Id Code Name IsArchived DefaultNominalCode")
          .sort({ updatedAt: -1 })
          .limit(10)
          .lean();
      }
    }
    // Build a Nominal map by Code for display (description/name) in draft view
    const Nominal = mdb.REST && mdb.REST.nominal;
    let nominalMap = {};
    if (Nominal) {
      // Fetch only nominals classified as "Purchases" so the per-line dropdown shows valid purchase accounts
      try {
        const docs = await Nominal.find({ Classification: "Purchases" })
          .select("Code Name Description Classification")
          .sort({ Code: 1 })
          .lean();
        nominalMap = (docs || []).reduce((acc, n) => {
          if (n && typeof n.Code === "number")
            acc[n.Code] = {
              Name: n.Name || null,
              Description: n.Description || null,
            };
          return acc;
        }, {});
      } catch (e) {
        logger.warn("Failed to load nominal map for draft view: " + e.message);
      }
    }

    // Load active KashFlow projects for per-line project assignment
    let activeProjects = [];
    const Project = mdb.REST && mdb.REST.project;
    if (Project) {
      try {
        activeProjects = await Project.find({
          Status: { $nin: ["Archived", "Completed"] },
        })
          .select("Number Name Status")
          .sort({ Number: 1 })
          .lean();
      } catch (e) {
        logger.warn("Failed to load active projects for draft view: " + e.message);
      }
    }

    const isSubcontractor = /subcontract/i.test(doc?.documentType?.name || "");

    // Subcontractor-only: bank accounts synced from KashFlow (hcs-sync) for the
    // payment-line Account selector, plus Method suggestions from PaymentLines
    // already present on synced purchases.
    let bankAccounts = [];
    let paymentAccounts = [];
    let paymentMethods = [];
    if (isSubcontractor) {
      const BankAccount = mdb.REST && mdb.REST.bankAccount;
      if (BankAccount) {
        try {
          bankAccounts = await BankAccount.find({
            $or: [{ IsArchived: { $ne: true } }, { IsArchived: { $exists: false } }],
          })
            .select("Id AccountName Code IsDefaultAccount")
            .sort({ IsDefaultAccount: -1, AccountName: 1 })
            .lean();
        } catch (e) {
          logger.warn("Failed to load bank accounts for draft view: " + e.message);
        }
      }
      const PurchaseModel = mdb.REST && mdb.REST.purchase;
      if (PurchaseModel) {
        try {
          const agg = await PurchaseModel.aggregate([
            {
              $project: {
                pl: { $ifNull: ["$PaymentLines", "$data.PaymentLines"] },
              },
            },
            { $unwind: "$pl" },
            {
              $facet: {
                accounts: [
                  { $match: { "pl.AccountId": { $type: "number" } } },
                  {
                    $group: {
                      _id: "$pl.AccountId",
                      count: { $sum: 1 },
                      lastDate: { $max: "$pl.Date" },
                    },
                  },
                  { $sort: { count: -1 } },
                  { $limit: 20 },
                ],
                methods: [
                  { $match: { "pl.Method": { $type: "number" } } },
                  { $group: { _id: "$pl.Method", count: { $sum: 1 } } },
                  { $sort: { count: -1 } },
                  { $limit: 20 },
                ],
              },
            },
          ]);
          paymentAccounts = (agg?.[0]?.accounts || []).map((a) => ({
            AccountId: a._id,
            count: a.count,
          }));
          paymentMethods = (agg?.[0]?.methods || []).map((m) => ({
            Method: m._id,
            count: m.count,
          }));
        } catch (e) {
          logger.warn(
            "Failed to aggregate payment account suggestions: " + e.message,
          );
        }
      }
    }

    const payloadPreview = (() => {
      try {
        return buildKashFlowPayloadFromDraft(draft);
      } catch (_) {
        return null;
      }
    })();

    // Expose send configuration to the view so users know what will happen when unchecking Dry run
    const KF_BASE = (
      process.env.KASHFLOW_API_BASE_URL || "https://api.kashflow.com/v2"
    ).replace(/\/+$/, "");
    const hasDirectAuth = !!(
      process.env.KASHFLOW_SESSION_TOKEN ||
      process.env.KFSESSIONTOKEN ||
      process.env.KASHFLOW_EXTERNAL_TOKEN ||
      ((process.env.KASHFLOW_API_USERNAME || process.env.KFUSERNAME) &&
        (process.env.KASHFLOW_API_PASSWORD || process.env.KFPASSWORD) &&
        (process.env.KASHFLOW_MEMORABLE || process.env.KFMEMORABLE))
    );
    const webhookUrl = process.env.KASHFLOW_CREATOR_WEBHOOK_URL || "";
    res.render(path.join("tailwindcss", "paperless", "draft"), {
      title: isSubcontractor
        ? `Subcontractor Invoice Draft • #${paperlessId}`
        : `Purchase Draft • #${paperlessId}`,
      paperlessId,
      isSubcontractor,
      doc,
      draft,
      suppliers,
      selectedSupplier,
      payloadPreview,
      sources,
      nominalMap,
      activeProjects,
      bankAccounts,
      paymentAccounts,
      paymentMethods,
      savedExtraLines: Array.isArray(doc.draftExtraLines) ? doc.draftExtraLines : [],
      sendDirectEnabled: hasDirectAuth,
      sendWebhookEnabled: !!webhookUrl,
      kashflowApiBaseUrl: KF_BASE,
      paperlessUiBase: (
        process.env.PAPERLESS_UI_URL ||
        (process.env.PAPERLESS_BASE_URL || '').replace(/\/api\/?$/i, '').replace(/\/+$/, '')
      ),
      canSend: (() => {
        const hasSupplier = !!(selectedSupplier || draft.SupplierId || draft.SupplierName);
        const lineItems = Array.isArray(draft.LineItems) ? draft.LineItems : [];
        const supplierDefaultNominal =
          (selectedSupplier && typeof selectedSupplier.DefaultNominalCode === 'number')
            ? selectedSupplier.DefaultNominalCode
            : (typeof draft.DefaultNominalCode === 'number' ? draft.DefaultNominalCode : null);
        const hasNominalPerLine =
          lineItems.length > 0 &&
          (lineItems.every((li) => typeof li.NominalCode === 'number') ||
            typeof supplierDefaultNominal === 'number');
        const toNum = (v) => { if (v == null || v === '') return null; const n = (typeof v === 'number') ? v : parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
        const _n = toNum(draft.NetAmount), _v = toNum(draft.VATAmount), _g = toNum(draft.GrossAmount);
        const totalsConsistent = (_n != null && _v != null && _g != null) ? Math.abs((_n + _v) - _g) < 0.01 : true;
        const tags = Array.isArray(doc?.tags) ? doc.tags : [];
        const tagNames = [...new Set(tags.map((t) => (typeof t === 'string' ? t : String(t?.name || t?.Name || '')).trim().toLowerCase()).filter(Boolean))];
        const hasKfNumber = !!(doc && (typeof doc.kashflowPurchaseNumber === 'number' || (typeof doc.kashflowPurchaseNumber === 'string' && doc.kashflowPurchaseNumber.trim() !== '')));
        const alreadySentLock = hasKfNumber && tagNames.length > 0 && tagNames.every((n) => n === 'added') && Number(doc?.lastSendStatus) === 201;
        return hasSupplier && lineItems.length > 0 && hasNominalPerLine && !!draft.Currency && totalsConsistent && !alreadySentLock;
      })(),
      alreadySentLock: (() => {
        const tags = Array.isArray(doc?.tags) ? doc.tags : [];
        const tagNames = [...new Set(tags.map((t) => (typeof t === 'string' ? t : String(t?.name || t?.Name || '')).trim().toLowerCase()).filter(Boolean))];
        const hasKfNumber = !!(doc && (typeof doc.kashflowPurchaseNumber === 'number' || (typeof doc.kashflowPurchaseNumber === 'string' && doc.kashflowPurchaseNumber.trim() !== '')));
        return hasKfNumber && tagNames.length > 0 && tagNames.every((n) => n === 'added') && Number(doc?.lastSendStatus) === 201;
      })(),
    });
  } catch (err) {
    logger.error("getPurchaseDraft error:", err);
    next(err);
  }
};

/**
 * Validate user-added draft line rows (posted from the draft view or being
 * saved to the document). Fully-empty rows are skipped; partially-filled rows
 * are an error. Returns { lines } with computed Net/Gross, or { error }.
 */
function parseExtraLineInput(extras, allowedNominalCodes) {
  const toNum = (v) => {
    if (v == null || v === "") return undefined;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  };
  const lines = [];
  for (let i = 0; i < extras.length; i++) {
    const ex = extras[i] || {};
    const desc = String(ex.Description || "").trim();
    const qty = toNum(ex.Quantity) ?? 1;
    const unit = toNum(ex.UnitPrice);
    const vatAmt = toNum(ex.VATAmount) ?? 0;
    // Skip fully empty rows
    if (!desc && unit == null) continue;
    if (!desc || unit == null || qty <= 0) {
      return {
        error: `Added line ${i + 1} is incomplete: description, quantity and unit price are required.`,
      };
    }
    const netAmt = +(qty * unit).toFixed(2);
    const line = {
      Description: desc,
      Quantity: qty,
      UnitPrice: unit,
      NetAmount: netAmt,
      VATAmount: +vatAmt.toFixed(2),
      GrossAmount: +(netAmt + vatAmt).toFixed(2),
    };
    const nom = toNum(ex.NominalCode);
    if (
      nom != null &&
      Number.isInteger(nom) &&
      (!allowedNominalCodes || allowedNominalCodes.has(nom))
    ) {
      line.NominalCode = nom;
    }
    const pn = toNum(ex.ProjectNumber);
    if (pn != null && Number.isInteger(pn) && pn > 0) {
      line.ProjectNumber = pn;
    }
    lines.push(line);
  }
  return { lines };
}

/** Load the set of nominal codes valid for purchase lines (Classification: 'Purchases'). */
async function loadAllowedNominalCodes() {
  const Nominal = mdb.REST && mdb.REST.nominal;
  if (!Nominal) return null;
  const allowed = await Nominal.find({ Classification: "Purchases" })
    .select("Code")
    .lean();
  return new Set(
    (allowed || [])
      .map((n) => (n && typeof n.Code === "number" ? n.Code : undefined))
      .filter((v) => v !== undefined),
  );
}

/**
 * Save user-added draft line items on the OCR document (subcontractor only),
 * so they survive draft reloads. POST body: { extraLines: [...] } (JSON).
 * An empty array clears the saved lines.
 */
export const saveDraftExtraLines = async (req, res) => {
  try {
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) {
      return res.status(400).json({ ok: false, message: "Invalid paperlessId" });
    }
    const doc = await OcrDocument.findOne({ paperlessId })
      .select("documentType")
      .lean();
    if (!doc) {
      return res.status(404).json({ ok: false, message: "Document not found" });
    }
    if (!/subcontract/i.test(doc?.documentType?.name || "")) {
      return res.status(400).json({
        ok: false,
        message: "Added line items are only supported on subcontractor documents.",
      });
    }
    const raw = req.body?.extraLines;
    let extras = Array.isArray(raw) ? raw : null;
    if (!extras && typeof raw === "string") {
      try {
        extras = JSON.parse(raw);
      } catch (_) {
        /* handled below */
      }
    }
    if (!Array.isArray(extras)) {
      return res.status(400).json({ ok: false, message: "extraLines must be an array" });
    }
    let allowedNominalCodes = null;
    try {
      allowedNominalCodes = await loadAllowedNominalCodes();
    } catch (e) {
      logger.warn("Failed to load allowed nominal codes for extra-line save: " + e.message);
    }
    const parsed = parseExtraLineInput(extras, allowedNominalCodes);
    if (parsed.error) {
      return res.status(400).json({ ok: false, message: parsed.error });
    }
    await OcrDocument.updateOne(
      { paperlessId },
      parsed.lines.length
        ? { $set: { draftExtraLines: parsed.lines } }
        : { $unset: { draftExtraLines: 1 } },
    );
    logger.info(
      `[paperless] Saved ${parsed.lines.length} draft extra line(s) for paperlessId=${paperlessId}`,
    );
    res.json({ ok: true, count: parsed.lines.length });
  } catch (err) {
    logger.error("saveDraftExtraLines error:", err);
    res.status(500).json({ ok: false, message: err.message || "Save failed" });
  }
};

/** Handle POST to send the draft to KashFlow (placeholder – external integration lives elsewhere) */
export const sendDraftToKashflow = async (req, res, next) => {
  // Send-claim state: released on every exit path; the 5-minute stale-claim
  // timeout in kashflowSendClaimService is the fallback if a release is missed.
  let sendClaimed = false;
  let claimedPaperlessId = null;
  const releaseSendClaim = async () => {
    if (!sendClaimed) return;
    sendClaimed = false;
    await kfSendClaim.releaseSend(mdb.PAPERLESS.OcrDocument, claimedPaperlessId);
  };
  try {
    const paperlessId = parseInt(req.params.paperlessId, 10);
    // Checkbox semantics: when unchecked, field is absent -> treat as false
    const dryRun = ["true", "on", "1", "yes"].includes(
      String(req.body?.dryRun || "").toLowerCase(),
    );

    // Server-side double-submit guard — atomically claim the document.
    // The old check-then-act read raced across the 20s KashFlow call: two
    // concurrent submits both passed and created two purchases.
    if (!dryRun) {
      await mdb.connect();
      const { OcrDocument } = mdb.PAPERLESS;
      const claim = await kfSendClaim.claimSend(OcrDocument, paperlessId);
      if (!claim.ok) {
        req.flash('error', claim.message);
        return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
      }
      sendClaimed = true;
      claimedPaperlessId = paperlessId;
    }

    // Rebuild draft server-side to avoid trusting client payload
    await mdb.connect();
    const draft = await buildPurchaseDraftById(paperlessId);
    // Detect document type for subcontractor mode
    const { OcrDocument: OcrDocumentSend } = mdb.PAPERLESS;
    const sendDoc = await OcrDocumentSend.findOne({ paperlessId }).select('documentType modified customFields').lean();
    const isSubcontractor = /subcontract/i.test(sendDoc?.documentType?.name || "");
    // Capture modified before the tag update so we can detect genuine post-send changes later
    const modifiedAtSendTime = sendDoc?.modified ?? null;
    // If a supplier is selected, merge its identifiers
    const supplierUuid =
      req.body && req.body.supplierUuid
        ? String(req.body.supplierUuid).trim()
        : "";
    if (supplierUuid) {
      const Supplier = mdb.REST && mdb.REST.supplier;
      if (Supplier) {
        const s = await Supplier.findOne({ uuid: supplierUuid }).lean();
        if (s) {
          draft.SupplierId = typeof s.Id === "number" ? s.Id : undefined;
          draft.SupplierCode = s.Code || draft.SupplierCode;
          draft.SupplierName = s.Name || draft.SupplierName;
          if (typeof s.DefaultNominalCode === "number") {
            draft.DefaultNominalCode = s.DefaultNominalCode;
          }
        }
      }
    }
    // Duplicate detection: block (unless overridden) when a purchase with the
    // same supplier + supplier reference already exists in the synced data —
    // catches the same invoice arriving twice via different documents.
    const forceDuplicate = ["true", "on", "1", "yes"].includes(
      String(req.body?.forceDuplicate || "").toLowerCase(),
    );
    if (!dryRun && !forceDuplicate && draft.SupplierReference) {
      const Purchase = mdb.REST && mdb.REST.purchase;
      if (Purchase) {
        const ref = String(draft.SupplierReference).trim();
        const refRegex = new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
        const supplierConds = [];
        if (draft.SupplierCode) {
          supplierConds.push({ SupplierCode: draft.SupplierCode }, { "data.SupplierCode": draft.SupplierCode });
        }
        if (typeof draft.SupplierId === "number") {
          supplierConds.push({ SupplierId: draft.SupplierId }, { "data.SupplierId": draft.SupplierId });
        }
        const dupQuery = {
          $and: [
            { $or: [{ SupplierReference: refRegex }, { "data.SupplierReference": refRegex }] },
            ...(supplierConds.length ? [{ $or: supplierConds }] : []),
          ],
        };
        const dup = await Purchase.findOne(dupQuery).select("Number data.Number").lean();
        if (dup) {
          const dupNumber = dup.Number ?? dup.data?.Number ?? "?";
          logger.warn(
            `[paperless] Duplicate blocked: supplier ref "${ref}" already on purchase #${dupNumber} (paperlessId=${paperlessId})`,
          );
          req.flash(
            "error",
            `A purchase with supplier reference "${ref}" already exists (purchase #${dupNumber}). ` +
              'If this is genuinely a different invoice, tick "override duplicate check" and send again.',
          );
          await releaseSendClaim();
          return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
        }
      }
    }

    // Load allowed nominal codes (Classification: 'Purchases') to validate selections
    let allowedNominalCodes = null;
    try {
      const Nominal = mdb.REST && mdb.REST.nominal;
      if (Nominal) {
        const allowed = await Nominal.find({ Classification: "Purchases" })
          .select("Code")
          .lean();
        allowedNominalCodes = new Set(
          (allowed || [])
            .map((n) => (n && typeof n.Code === "number" ? n.Code : undefined))
            .filter((v) => v !== undefined),
        );
      }
    } catch (e) {
      logger.warn(
        "Failed to load allowed nominal codes for send validation: " +
          e.message,
      );
    }
    // Apply per-line nominal codes posted from the draft view (nominalCodes[])
    // Accept both nominalCodes[] and nominalCodes to be robust to body parsers
    const postedNominalRaw =
      (req.body && (req.body["nominalCodes[]"] ?? req.body.nominalCodes)) ?? [];
    const postedNominals = Array.isArray(postedNominalRaw)
      ? postedNominalRaw
      : typeof postedNominalRaw === "string"
        ? [postedNominalRaw]
        : [];

    // For subcontractor documents with a single fallback line, expand to labour + materials
    // so the server payload mirrors exactly what the draft view showed the user.
    if (
      isSubcontractor &&
      Array.isArray(draft.LineItems) &&
      draft.LineItems.length === 1 &&
      !( draft.Debug && Array.isArray(draft.Debug.EnumeratedLineItems) && draft.Debug.EnumeratedLineItems.length > 0 )
    ) {
      const labourLine = Object.assign({}, draft.LineItems[0], {
        Description: draft.LineItems[0].Description || "Sub-contractor Labour",
      });
      const materialsLine = {
        Description: "Materials",
        Quantity: 1,
        UnitPrice: null,
        NetAmount: null,
        VATAmount: null,
        GrossAmount: null,
      };
      draft.LineItems = [labourLine, materialsLine];
    }

    if (
      Array.isArray(draft.LineItems) &&
      draft.LineItems.length > 0 &&
      postedNominals.length > 0
    ) {
      for (
        let i = 0;
        i < draft.LineItems.length && i < postedNominals.length;
        i++
      ) {
        const li = draft.LineItems[i] || {};
        const raw = postedNominals[i];
        if (raw == null) continue; // nothing provided for this line
        const txt = String(raw).trim();
        if (txt === "") {
          // Explicit empty => remove per-line nominal so supplier default (if any) applies
          if ("NominalCode" in li) delete li.NominalCode;
          continue;
        }
        const code = parseInt(txt, 10);
        if (
          Number.isFinite(code) &&
          (!allowedNominalCodes || allowedNominalCodes.has(code))
        ) {
          li.NominalCode = code;
        } else {
          // Invalid value -> clear to allow default fallback
          if ("NominalCode" in li) delete li.NominalCode;
        }
        draft.LineItems[i] = li;
      }
    }

    // Apply per-line project numbers posted from the draft view (projectNumbers[])
    const postedProjectRaw =
      (req.body && (req.body["projectNumbers[]"] ?? req.body.projectNumbers)) ?? [];
    const postedProjects = Array.isArray(postedProjectRaw)
      ? postedProjectRaw
      : typeof postedProjectRaw === "string"
        ? [postedProjectRaw]
        : [];
    if (Array.isArray(draft.LineItems) && postedProjects.length > 0) {
      for (let i = 0; i < draft.LineItems.length && i < postedProjects.length; i++) {
        const li = draft.LineItems[i] || {};
        const txt = String(postedProjects[i] || "").trim();
        if (txt === "") {
          delete li.ProjectNumber;
          delete li.ProjectName;
        } else {
          const pn = parseInt(txt, 10);
          if (Number.isFinite(pn) && pn > 0) {
            li.ProjectNumber = pn;
          } else {
            delete li.ProjectNumber;
            delete li.ProjectName;
          }
        }
        draft.LineItems[i] = li;
      }
    }

    // Subcontractor-only: append user-added line items posted from the draft view.
    // Each entry carries its own nominal/project so it doesn't disturb the
    // index-aligned nominalCodes[]/projectNumbers[] arrays above.
    if (isSubcontractor && req.body && req.body.extraLines) {
      let extras;
      try {
        extras = JSON.parse(String(req.body.extraLines));
      } catch (_) {
        extras = null;
      }
      if (!Array.isArray(extras)) {
        req.flash("error", "Could not read the added line items. Please re-check them and try again.");
        await releaseSendClaim();
        return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
      }
      const parsedExtras = parseExtraLineInput(extras, allowedNominalCodes);
      if (parsedExtras.error) {
        req.flash("error", parsedExtras.error);
        await releaseSendClaim();
        return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
      }
      draft.LineItems.push(...parsedExtras.lines);
    }

    // Subcontractor-only: attach payment lines posted from the draft view.
    // These pass through buildKashFlowPayloadFromDraft as PaymentLines.
    if (isSubcontractor && req.body && req.body.paymentLines) {
      let pls;
      try {
        pls = JSON.parse(String(req.body.paymentLines));
      } catch (_) {
        pls = null;
      }
      if (!Array.isArray(pls)) {
        req.flash("error", "Could not read the payment lines. Please re-check them and try again.");
        await releaseSendClaim();
        return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
      }
      const toNum = (v) => {
        if (v == null || v === "") return undefined;
        const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
        return Number.isFinite(n) ? n : undefined;
      };
      const paymentLines = [];
      for (let i = 0; i < pls.length; i++) {
        const pl = pls[i] || {};
        const accountId = toNum(pl.AccountId);
        const amount = toNum(pl.Amount);
        const dateStr = String(pl.Date || "").trim();
        const method = toNum(pl.Method);
        const note = String(pl.Note || "").trim();
        // Skip fully empty rows
        if (accountId == null && amount == null && !dateStr && !note) continue;
        if (accountId == null || !Number.isInteger(accountId) || accountId <= 0 || amount == null || amount === 0) {
          req.flash(
            "error",
            `Payment line ${i + 1} is incomplete: a valid Account Id and a non-zero amount are required.`,
          );
          await releaseSendClaim();
          return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
        }
        let date;
        if (dateStr) {
          const d = new Date(dateStr);
          if (isNaN(d)) {
            req.flash("error", `Payment line ${i + 1} has an invalid date.`);
            await releaseSendClaim();
            return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
          }
          date = d;
        }
        paymentLines.push({
          AccountId: accountId,
          Amount: +amount.toFixed(2),
          Date: date,
          Method: method != null && Number.isInteger(method) ? method : undefined,
          Note: note || undefined,
        });
      }
      if (paymentLines.length > 0) draft.PaymentLines = paymentLines;
    }

    // Look up project names for any line-level project numbers and propagate to header
    try {
      const projectNumbersInUse = new Set(
        (draft.LineItems || []).map(li => li.ProjectNumber).filter(n => typeof n === 'number' && n > 0)
      );
      if (projectNumbersInUse.size > 0) {
        const RestProject = mdb.REST && mdb.REST.project;
        if (RestProject) {
          const projects = await RestProject.find({ Number: { $in: Array.from(projectNumbersInUse) } })
            .select('Number Name')
            .lean();
          const projectNameMap = {};
          for (const p of projects) {
            if (p.Number != null) projectNameMap[p.Number] = p.Name || '';
          }
          for (const li of (draft.LineItems || [])) {
            if (typeof li.ProjectNumber === 'number' && li.ProjectNumber > 0) {
              li.ProjectName = projectNameMap[li.ProjectNumber] ?? '';
            }
          }
          // Set header-level project when all lines share the same project
          const uniqueNums = Array.from(projectNumbersInUse);
          if (uniqueNums.length === 1) {
            draft.ProjectNumber = uniqueNums[0];
            draft.ProjectName = projectNameMap[uniqueNums[0]] ?? '';
          }
        }
      }
    } catch (e) {
      logger.warn('Failed to look up project names for KashFlow payload: ' + e.message);
    }

    const webhookUrl = process.env.KASHFLOW_CREATOR_WEBHOOK_URL;
    const webhookToken = process.env.KASHFLOW_CREATOR_WEBHOOK_TOKEN;

    // Optional direct-to-KashFlow configuration
    const KF_BASE = (
      process.env.KASHFLOW_API_BASE_URL || "https://api.kashflow.com/v2"
    ).replace(/\/+$/, "");
    // We now prefer session-token auth (KfToken) over Basic
    const kfSession = __kashflowSessionService;
    const hasDirectAuth = !!(
      process.env.KASHFLOW_SESSION_TOKEN ||
      process.env.KFSESSIONTOKEN ||
      process.env.KASHFLOW_EXTERNAL_TOKEN ||
      ((process.env.KASHFLOW_API_USERNAME || process.env.KFUSERNAME) &&
        (process.env.KASHFLOW_API_PASSWORD || process.env.KFPASSWORD) &&
        (process.env.KASHFLOW_MEMORABLE || process.env.KFMEMORABLE))
    );

    // Load VAT levels from MongoDB (synced by hcs-sync) to snap VATLevel on the payload.
    let vatLevels = [];
    try {
      vatLevels = await kfVat.getVatLevels();
    } catch (e) {
      logger.warn(
        `[vatService] Failed to load VAT rates; will send payload without snapping VATLevel. ${e.message}`,
      );
    }

    const payload = buildKashFlowPayloadFromDraft(draft, { vatLevels });

    let result = {
      paperlessId,
      mode: null,
      endpoint: null,
      status: null,
      ok: false,
      message: null,
      location: null,
      response: null,
    };

    if (dryRun) {
      // Simulated send – log payload and inform user
      logger.info(
        `[kashflow] DRY-RUN create Purchase for paperlessId=${paperlessId}${!webhookUrl && !hasDirectAuth ? " (no sender configured)" : ""}`,
        { payload },
      );
      const msg = `Dry run only${!webhookUrl && !hasDirectAuth ? " (no sender configured)" : ""}. No data sent.`;
      result = {
        ...result,
        mode: "dry-run",
        ok: true,
        message: msg,
        response: null,
      };
      req.flash("success", msg);
    } else if (hasDirectAuth) {
      // Prefer direct send to KashFlow when credentials are configured
      try {
        const url = `${KF_BASE}/purchases`;
        const resp = await kfSession.withKfAuth(async (token) => {
          const headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `KfToken ${token}`,
            "User-Agent": `sms-app/${process.env.npm_package_version || "0.0.0"}`,
          };
          return kfAxios.post(url, payload, { headers, timeout: 20000 });
        });
        logger.info(
          `[kashflow] Direct create Purchase OK for paperlessId=${paperlessId}. status=${resp.status}`,
        );
        result = {
          ...result,
          mode: "direct",
          endpoint: url,
          status: resp.status,
          ok: true,
          location: resp.headers?.location || null,
          message: "Purchase created in KashFlow.",
          response: resp.data || null,
        };
        // Post-send enrichment: persist KashFlow linkage back to the OCR document
        try {
          await mdb.connect();
          const { OcrDocument } = mdb.PAPERLESS;
          const _rawId = resp?.data?.Id;
          const purchaseId = typeof _rawId === 'number' && Number.isFinite(_rawId) ? _rawId
            : typeof _rawId === 'string' && Number.isFinite(parseInt(_rawId, 10)) ? parseInt(_rawId, 10)
            : null;
          const _rawNum = resp?.data?.Number;
          const purchaseNumber = typeof _rawNum === 'number' && Number.isFinite(_rawNum) ? _rawNum
            : typeof _rawNum === 'string' && Number.isFinite(parseInt(_rawNum, 10)) ? parseInt(_rawNum, 10)
            : null;
          const permalink =
            (resp?.data &&
              typeof resp.data.Permalink === "string" &&
              resp.data.Permalink) ||
            resp?.headers?.location ||
            null;
          await OcrDocument.updateOne(
            { paperlessId },
            {
              $set: {
                kashflowPurchaseId: purchaseId,
                kashflowPurchaseNumber: purchaseNumber,
                kashflowPermalink: permalink,
                lastSentAt: new Date(),
                lastSendMode: "direct",
                lastSendStatus: resp.status,
                modifiedAtLastSend: modifiedAtSendTime,
              },
              $inc: { sendCount: 1 },
            },
          );
        } catch (persistErr) {
          logger.warn(
            `Post-send persist (direct) failed for paperlessId=${paperlessId}: ${persistErr.message}`,
          );
        }
        req.flash("success", "Purchase created in KashFlow.");

        // Await before ingest so Paperless custom fields are written before we re-fetch
        try {
          await updatePaperlessWithKashFlowInfo(
            paperlessId,
            resp.data,
            resp.status,
            { existingCf: sendDoc?.customFields || [] },
          );
        } catch (e) {
          logger.warn(
            `updatePaperlessWithKashFlowInfo failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        }

        await updatePaperlessDocumentTags(paperlessId, ["added"]).catch((e) => {
          logger.warn(
            `Async updatePaperlessDocumentTags failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        });

        // Immediately ingest the same file back into our database so UI reflects latest tags/fields
        try {
          await ingestOnePaperlessDoc(paperlessId);
        } catch (e) {
          logger.warn(
            `Post-send ingest failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        }
      } catch (sendErr) {
        const status = sendErr?.response?.status;
        const data = sendErr?.response?.data;
        const msg = status ? `${status} ${sendErr.message}` : sendErr.message;
        // Log more diagnostics to help identify 404 causes (e.g., path vs. validation)
        logger.error(
          `[kashflow] Direct send failed for paperlessId=${paperlessId}: ${msg}`,
        );
        if (data) {
          logger.error(
            `[kashflow] Error body: ${typeof data === "object" ? JSON.stringify(data) : String(data).slice(0, 2000)}`,
          );
        }
        result = {
          ...result,
          mode: "direct",
          endpoint: `${KF_BASE}/purchases`,
          status: status || null,
          ok: false,
          message: `Direct send failed: ${msg}`,
          response: data || { error: sendErr.message },
        };
        req.flash("error", result.message);
      }
    } else if (webhookUrl) {
      // Fallback to external creator webhook if configured
      try {
        const headers = { "Content-Type": "application/json" };
        if (webhookToken) headers["Authorization"] = `Bearer ${webhookToken}`;
        const resp = await axios.post(
          webhookUrl,
          { type: "purchase.create", paperlessId, payload },
          { headers, timeout: 15000 },
        );
        logger.info(
          `[kashflow] Sent create Purchase for paperlessId=${paperlessId} via webhook. status=${resp.status}`,
        );
        result = {
          ...result,
          mode: "webhook",
          endpoint: webhookUrl,
          status: resp.status,
          ok: true,
          location: resp.headers?.location || null,
          message: "Draft sent to KashFlow creator webhook.",
          response: resp.data || null,
        };
        // Post-send enrichment (best-effort): if webhook returns KF details, persist linkage
        try {
          await mdb.connect();
          const { OcrDocument } = mdb.PAPERLESS;
          const body = resp?.data || {};
          const _rawWId = body?.Id;
          const purchaseId = typeof _rawWId === 'number' && Number.isFinite(_rawWId) ? _rawWId
            : typeof _rawWId === 'string' && Number.isFinite(parseInt(_rawWId, 10)) ? parseInt(_rawWId, 10)
            : null;
          const _rawWNum = body?.Number;
          const purchaseNumber = typeof _rawWNum === 'number' && Number.isFinite(_rawWNum) ? _rawWNum
            : typeof _rawWNum === 'string' && Number.isFinite(parseInt(_rawWNum, 10)) ? parseInt(_rawWNum, 10)
            : null;
          const permalink =
            (typeof body?.Permalink === "string" && body.Permalink) ||
            resp?.headers?.location ||
            null;
          if (purchaseId != null || purchaseNumber != null || permalink) {
            await OcrDocument.updateOne(
              { paperlessId },
              {
                $set: {
                  kashflowPurchaseId: purchaseId,
                  kashflowPurchaseNumber: purchaseNumber,
                  kashflowPermalink: permalink,
                  lastSentAt: new Date(),
                  lastSendMode: "webhook",
                  lastSendStatus: resp.status,
                  modifiedAtLastSend: modifiedAtSendTime,
                },
                $inc: { sendCount: 1 },
              },
            );
          } else {
            // Still track the send attempt
            await OcrDocument.updateOne(
              { paperlessId },
              {
                $set: {
                  lastSentAt: new Date(),
                  lastSendMode: "webhook",
                  lastSendStatus: resp.status,
                  modifiedAtLastSend: modifiedAtSendTime,
                },
              },
            );
          }
        } catch (persistErr) {
          logger.warn(
            `Post-send persist (webhook) failed for paperlessId=${paperlessId}: ${persistErr.message}`,
          );
        }
        req.flash("success", "Draft sent to KashFlow creator webhook.");

        // Reflect webhook result into Paperless custom fields before re-ingest
        try {
          await updatePaperlessWithKashFlowInfo(
            paperlessId,
            resp.data,
            resp.status,
            { existingCf: sendDoc?.customFields || [] },
          );
        } catch (e) {
          logger.warn(
            `updatePaperlessWithKashFlowInfo (webhook) failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        }

        // Ingest latest state back into Mongo immediately
        try {
          await ingestOnePaperlessDoc(paperlessId);
        } catch (e) {
          logger.warn(
            `Post-webhook ingest failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        }
      } catch (sendErr) {
        const status = sendErr?.response?.status;
        const detail = sendErr?.response?.data || { error: sendErr.message };
        logger.error(
          `[kashflow] Webhook send failed for paperlessId=${paperlessId}: ${sendErr.message}`,
        );
        result = {
          ...result,
          mode: "webhook",
          endpoint: webhookUrl,
          status: status || null,
          ok: false,
          message: `Webhook send failed: ${sendErr.message}`,
          response: detail,
        };
        req.flash("error", result.message);
      }
    } else {
      // Nothing configured to actually send
      const msg = "Dry run only (no direct/webhook configured). No data sent.";
      logger.info(
        `[kashflow] DRY-RUN (no direct/webhook configured) create Purchase for paperlessId=${paperlessId}`,
        { payload },
      );
      result = {
        ...result,
        mode: "dry-run",
        ok: true,
        message: msg,
        response: null,
      };
      req.flash("success", msg);
    }
    await releaseSendClaim();

    // Render a dedicated result view with details
    res.render(path.join("tailwindcss", "paperless", "sendResult"), {
      title: "KashFlow Send Result",
      paperlessId,
      result,
      // Provide a minimal view of what was sent for traceability
      payload,
      draft,
    });
  } catch (err) {
    logger.error("sendDraftToKashflow error:", err);
    await releaseSendClaim().catch(() => {});
    req.flash("error", `Send failed: ${err.message}`);
    res.render(path.join("tailwindcss", "paperless", "sendResult"), {
      title: "KashFlow Send Result",
      paperlessId: parseInt(req.params.paperlessId, 10),
      result: {
        ok: false,
        message: err.message,
        mode: null,
        endpoint: null,
        status: null,
        location: null,
        response: null,
      },
      payload: null,
      draft: null,
    });
  }
};

/** JSON supplier search: GET /paperless/suppliers?q=&limit= */
export const searchSuppliers = async (req, res, next) => {
  try {
    await mdb.connect();
    const Supplier = mdb.REST && mdb.REST.supplier;
    if (!Supplier)
      return res.status(501).json({ error: "Supplier model unavailable" });
    const q = String(req.query.q || "").trim();
    const limit = Math.min(
      25,
      Math.max(1, parseInt(req.query.limit || "10", 10)),
    );
    const filter = q
      ? {
          $or: [
            { Name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
            { Code: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          ],
          IsArchived: { $ne: true },
        }
      : { IsArchived: { $ne: true } };
    const docs = await Supplier.find(filter)
      .select("uuid Id Code Name IsArchived DefaultNominalCode")
      .limit(limit)
      .lean();
    res.json({ items: docs });
  } catch (err) {
    next(err);
  }
};

/** JSON supplier create: POST /paperless/suppliers { name, code?, defaultNominalCode? }
 *  Creates the supplier directly in KashFlow, then upserts it into the local
 *  REST suppliers collection so the draft-page picker can use it immediately
 *  (the next hcs-sync run reconciles the full record). */
export const createSupplier = async (req, res, next) => {
  try {
    await mdb.connect();
    const Supplier = mdb.REST && mdb.REST.supplier;
    if (!Supplier)
      return res.status(501).json({ error: "Supplier model unavailable" });

    const name = String(req.body?.name || "").trim();
    if (!name)
      return res.status(400).json({ error: "Supplier name is required." });
    if (name.length > 200)
      return res.status(400).json({ error: "Supplier name is too long (max 200 characters)." });
    let code = String(req.body?.code || "").trim().toUpperCase();
    if (code && !/^[A-Z0-9_-]{1,20}$/.test(code))
      return res.status(400).json({
        error: "Supplier code may only contain letters, numbers, hyphens and underscores (max 20).",
      });

    // Optional default nominal — must be a valid Purchases nominal when we can check
    let defaultNominalCode;
    const nominalRaw = String(req.body?.defaultNominalCode ?? "").trim();
    if (nominalRaw !== "") {
      const n = parseInt(nominalRaw, 10);
      if (!Number.isFinite(n))
        return res.status(400).json({ error: "Default nominal code must be a number." });
      try {
        const Nominal = mdb.REST && mdb.REST.nominal;
        if (Nominal) {
          const found = await Nominal.findOne({ Code: n, Classification: "Purchases" })
            .select("Code")
            .lean();
          if (!found)
            return res.status(400).json({
              error: `Nominal code ${n} is not a Purchases nominal.`,
            });
        }
      } catch (e) {
        logger.warn("Nominal validation skipped for supplier create: " + e.message);
      }
      defaultNominalCode = n;
    }

    // If an active supplier with this exact name already exists, hand it back
    // instead of creating a duplicate in KashFlow.
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existing = await Supplier.findOne({
      Name: new RegExp(`^${safe}$`, "i"),
      IsArchived: { $ne: true },
    })
      .select("uuid Id Code Name DefaultNominalCode")
      .lean();
    if (existing)
      return res.status(409).json({
        error: `A supplier named "${existing.Name}" already exists.`,
        item: existing,
      });

    // Creating requires direct KashFlow credentials (same check as sending)
    const hasDirectAuth = !!(
      process.env.KASHFLOW_SESSION_TOKEN ||
      process.env.KFSESSIONTOKEN ||
      process.env.KASHFLOW_EXTERNAL_TOKEN ||
      ((process.env.KASHFLOW_API_USERNAME || process.env.KFUSERNAME) &&
        (process.env.KASHFLOW_API_PASSWORD || process.env.KFPASSWORD) &&
        (process.env.KASHFLOW_MEMORABLE || process.env.KFMEMORABLE))
    );
    if (!hasDirectAuth)
      return res.status(501).json({
        error: "KashFlow credentials are not configured on this server; supplier creation is unavailable.",
      });

    // Derive a code from the name when none supplied; KashFlow de-dupes it for us
    if (!code) {
      code = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "SUPPLIER";
    }
    const payload = {
      Code: code,
      Name: name,
      CreateSupplierCodeIfDuplicate: true,
      ...(defaultNominalCode != null ? { DefaultNominalCode: defaultNominalCode } : {}),
    };

    const KF_BASE = (
      process.env.KASHFLOW_API_BASE_URL || "https://api.kashflow.com/v2"
    ).replace(/\/+$/, "");
    const url = `${KF_BASE}/suppliers`;
    let resp;
    try {
      resp = await kfSession.withKfAuth(async (token) => {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `KfToken ${token}`,
          "User-Agent": `sms-app/${process.env.npm_package_version || "0.0.0"}`,
        };
        return kfAxios.post(url, payload, { headers, timeout: 20000 });
      });
    } catch (sendErr) {
      const status = sendErr?.response?.status;
      const data = sendErr?.response?.data;
      logger.error(
        `[kashflow] Supplier create failed for "${name}": ${status ? status + " " : ""}${sendErr.message}`,
      );
      if (data) {
        logger.error(
          `[kashflow] Error body: ${typeof data === "object" ? JSON.stringify(data) : String(data).slice(0, 2000)}`,
        );
      }
      const detail =
        (data && typeof data === "object" && (data.Message || data.message)) ||
        sendErr.message;
      return res
        .status(502)
        .json({ error: `KashFlow rejected the supplier: ${detail}` });
    }

    const created = resp?.data || {};
    const rawId = created.Id;
    const kfId =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? rawId
        : Number.isFinite(parseInt(rawId, 10))
          ? parseInt(rawId, 10)
          : null;
    const finalCode = created.Code || code;
    const finalName = created.Name || name;

    // Upsert locally so the picker (and duplicate checks) see it before the next sync
    const setFields = {
      Code: finalCode,
      Name: finalName,
      IsArchived: false,
      ...(kfId != null ? { Id: kfId } : {}),
      ...(typeof created.DefaultNominalCode === "number"
        ? { DefaultNominalCode: created.DefaultNominalCode }
        : defaultNominalCode != null
          ? { DefaultNominalCode: defaultNominalCode }
          : {}),
      ...(created.CreatedDate ? { CreatedDate: created.CreatedDate } : {}),
      ...(created.SourceName ? { SourceName: created.SourceName } : {}),
    };
    const doc = await Supplier.findOneAndUpdate(
      kfId != null ? { Id: kfId } : { Code: finalCode },
      { $set: setFields },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    logger.info(
      `[kashflow] Supplier created: "${finalName}" (Code=${finalCode}, Id=${kfId ?? "?"}) by ${req.user?.email || req.user?.username || "unknown user"}`,
    );
    return res.status(201).json({
      item: {
        uuid: doc.uuid,
        Id: doc.Id ?? null,
        Code: doc.Code || null,
        Name: doc.Name || null,
        DefaultNominalCode:
          typeof doc.DefaultNominalCode === "number" ? doc.DefaultNominalCode : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

/** POST /paperless/ocr/:paperlessId/ingest — re-ingest a single document from Paperless */
export const reIngestOne = async (req, res, next) => {
  try {
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) {
      return res.status(400).json({ error: 'Invalid paperlessId' });
    }
    const result = await ingestOnePaperlessDoc(paperlessId);
    req.flash('success', `Document #${paperlessId} re-ingested successfully.`);
    res.redirect(`/paperless/ocr/${paperlessId}`);
  } catch (err) {
    logger.error(`reIngestOne error for paperlessId=${req.params.paperlessId}: ${err.message}`);
    if (err.status === 404) {
      req.flash('error', err.message);
      return res.redirect(`/paperless/ocr/${req.params.paperlessId}`);
    }
    next(err);
  }
};

/** GET /paperless/ocr/:paperlessId/match — manual purchase-matching UI */
export const getMatchPurchase = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) return res.status(400).render('error', { message: 'Invalid paperlessId' });

    const doc = await OcrDocument.findOne({ paperlessId }).lean();
    if (!doc) return res.status(404).render('error', { message: 'OCR document not found.' });

    // Resolve existing linked purchase from REST (null if not found / deleted)
    let currentPurchase = null;
    const Purchase = mdb.REST?.purchase;
    if (Purchase && doc.kashflowPurchaseId) {
      currentPurchase = await Purchase.findOne({ Id: doc.kashflowPurchaseId })
        .select('Id Number SupplierName SupplierReference IssuedDate GrossAmount NetAmount Status Permalink')
        .lean();
    }

    // Search results
    const q = String(req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = 20;
    let purchases = [];
    let purchaseTotal = 0;

    if (Purchase && q) {
      const numQ = parseInt(q, 10);
      const filter = Number.isFinite(numQ) && String(numQ) === q
        ? { Number: numQ }
        : {
            $or: [
              { SupplierName:      { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
              { SupplierReference: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            ],
          };
      [purchaseTotal, purchases] = await Promise.all([
        Purchase.countDocuments(filter),
        Purchase.find(filter)
          .select('Id Number SupplierName SupplierReference IssuedDate GrossAmount NetAmount VATAmount Status Permalink')
          .sort({ Number: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .lean(),
      ]);
    }

    res.render(path.join('tailwindcss', 'paperless', 'match'), {
      title: `Match Purchase — Doc #${paperlessId}`,
      doc,
      currentPurchase,
      q,
      page,
      pageSize,
      purchases,
      purchaseTotal,
      pages: Math.max(1, Math.ceil(purchaseTotal / pageSize)),
    });
  } catch (err) {
    next(err);
  }
};

/** POST /paperless/ocr/:paperlessId/match — confirm a purchase link */
export const postMatchPurchase = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) return res.status(400).render('error', { message: 'Invalid paperlessId' });

    const purchaseNumber = parseInt(req.body.purchaseNumber, 10);
    const purchaseId     = parseInt(req.body.purchaseId, 10);
    if (!Number.isFinite(purchaseNumber) || !Number.isFinite(purchaseId)) {
      req.flash('error', 'No purchase selected.');
      return res.redirect(`/paperless/ocr/${paperlessId}/match`);
    }

    // Re-confirm the purchase still exists in REST
    const Purchase = mdb.REST?.purchase;
    const restPurchase = Purchase
      ? await Purchase.findOne({ Id: purchaseId, Number: purchaseNumber })
          .select('Id Number Permalink')
          .lean()
      : null;

    if (!restPurchase) {
      req.flash('error', `Purchase #${purchaseNumber} (Id ${purchaseId}) not found in REST — it may have been deleted.`);
      return res.redirect(`/paperless/ocr/${paperlessId}/match`);
    }

    // Update MongoDB
    await OcrDocument.updateOne(
      { paperlessId },
      {
        $set: {
          kashflowPurchaseId:     restPurchase.Id,
          kashflowPurchaseNumber: restPurchase.Number,
          kashflowPermalink:      restPurchase.Permalink ?? null,
        },
      },
    );
    logger.info(`[matchPurchase] Manually linked paperlessId=${paperlessId} → purchase #${purchaseNumber} (Id=${purchaseId})`);

    // Write back to Paperless custom fields (best-effort)
    try {
      const docForCf = await OcrDocument.findOne({ paperlessId }).select('customFields').lean();
      await updatePaperlessWithKashFlowInfo(
        paperlessId,
        restPurchase,
        200,
        { existingCf: docForCf?.customFields || [] },
      );
    } catch (cfErr) {
      logger.warn(`[matchPurchase] CF write-back failed for paperlessId=${paperlessId}: ${cfErr.message}`);
    }

    // Re-ingest so UI reflects the new CF values
    try {
      await ingestOnePaperlessDoc(paperlessId);
    } catch (ingestErr) {
      logger.warn(`[matchPurchase] Re-ingest failed for paperlessId=${paperlessId}: ${ingestErr.message}`);
    }

    req.flash('success', `Linked to KashFlow purchase #${purchaseNumber}.`);
    res.redirect(`/paperless/ocr/${paperlessId}`);
  } catch (err) {
    next(err);
  }
};

/** POST /paperless/ocr/:paperlessId/unlink — clear stale KashFlow linkage */
export const unlinkKashflow = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) {
      return res.status(400).json({ error: 'Invalid paperlessId' });
    }
    await OcrDocument.updateOne(
      { paperlessId },
      {
        $set: {
          kashflowPurchaseId:     null,
          kashflowPurchaseNumber: null,
          kashflowPermalink:      null,
        },
      },
    );
    // Clear the matching custom fields on the Paperless-ngx document too
    try {
      const { makeClient } = __paperlessClient_;
      await makeClient().updateDocumentCustomFields(paperlessId, {
        'KashFlow Purchase Id':        null,
        'KashFlow Purchase Number':    null,
        'KashFlow Purchase Permalink': null,
        'KashFlow Last Send Status':   null,
      });
    } catch (updateErr) {
      logger.warn(`[paperless] Could not clear Paperless custom fields for doc ${paperlessId}: ${updateErr.message}`);
    }
    logger.info(`[paperless] Unlinked KashFlow linkage for paperlessId=${paperlessId}`);
    req.flash('success', `KashFlow link removed from document #${paperlessId}.`);
    res.redirect(`/paperless/ocr/${paperlessId}`);
  } catch (err) {
    logger.error(`unlinkKashflow error for paperlessId=${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

/** POST /paperless/clear-orphans — manually trigger an orphan-link sweep (runs in background) */
let _clearOrphansRunning = false;
export const clearOrphans = async (req, res) => {
  if (_clearOrphansRunning) {
    logger.warn('[clearOrphans] Already running — ignoring duplicate request');
    return res.redirect('/overview/documents');
  }
  res.redirect('/overview/documents');
  setImmediate(async () => {
    _clearOrphansRunning = true;
    try {
      const { detectAndClearOrphans } = __ocrOrphanService;
      const stats = await detectAndClearOrphans();
      logger.info(`[clearOrphans] Manual run complete. checked=${stats.checked} cleared=${stats.cleared} errors=${stats.errors}`);
    } catch (err) {
      logger.error(`[clearOrphans] Fatal error: ${err.message}`);
    } finally {
      _clearOrphansRunning = false;
    }
  });
};

/** DELETE /paperless/ocr/:paperlessId — remove an OcrDocument (and its ingest record) */

/** POST /paperless/resolve-numbers — for each unlinked doc with a kashflowPurchaseNumber,
 *  look up the purchase in REST by that number and populate kashflowPurchaseId. */
let _resolveNumbersRunning = false;
export const resolveNumbers = async (req, res) => {
  if (_resolveNumbersRunning) {
    logger.warn('[resolveNumbers] Already running — ignoring duplicate request');
    return res.redirect('/overview/documents');
  }
  res.redirect('/overview/documents');
  setImmediate(async () => {
    _resolveNumbersRunning = true;
    try {
      await mdb.connect();
      const { OcrDocument } = mdb.PAPERLESS;
      const Purchase = mdb.REST?.purchase;
      if (!Purchase) {
        logger.error('[resolveNumbers] REST purchase model not available');
        return;
      }

      const unlinkedWithNumber = await OcrDocument
        .find({ kashflowPurchaseId: null, kashflowPurchaseNumber: { $ne: null }, deletedInPaperlessAt: null })
        .select('paperlessId kashflowPurchaseNumber customFields lastSendStatus')
        .lean();

      logger.info(`[resolveNumbers] Found ${unlinkedWithNumber.length} docs with a KashFlow number but no ID`);

      // Pre-warm the CF definitions cache once before the loop for efficient batch CF updates
      try {
        await warmCfCache(OcrDocument);
      } catch (cacheErr) {
        logger.warn(`[resolveNumbers] Could not pre-warm CF cache: ${cacheErr.message}`);
      }

      let ok = 0, notFound = 0, fail = 0;
      for (const doc of unlinkedWithNumber) {
        try {
          const purchase = await Purchase
            .findOne({ Number: doc.kashflowPurchaseNumber, deletedAt: null, DeletedAt: null })
            .select('Id Number Permalink')
            .lean();

          if (!purchase) {
            // Diagnose the miss: soft-deleted purchase, or the stored value is a KashFlow
            // Id rather than a Number (older CF backfills wrote the Id in some paths).
            const [softDeleted, byId] = await Promise.all([
              Purchase.findOne({ Number: doc.kashflowPurchaseNumber, $or: [{ deletedAt: { $ne: null } }, { DeletedAt: { $ne: null } }] })
                .select('Id Number deletedAt DeletedAt').lean(),
              Purchase.findOne({ Id: doc.kashflowPurchaseNumber, deletedAt: null, DeletedAt: null })
                .select('Id Number SupplierName SupplierReference').lean(),
            ]);
            if (softDeleted) {
              logger.warn(`[resolveNumbers] Purchase number ${doc.kashflowPurchaseNumber} exists in REST but is soft-deleted (Id=${softDeleted.Id}) for paperlessId=${doc.paperlessId}`);
            } else if (byId) {
              logger.warn(`[resolveNumbers] No purchase with Number ${doc.kashflowPurchaseNumber}, but it matches KashFlow Id ${byId.Id} (Number=${byId.Number}, supplier="${byId.SupplierName}", ref="${byId.SupplierReference}") for paperlessId=${doc.paperlessId} — the stored value is likely an Id, not a Number; verify and relink manually or via Match References`);
            } else {
              logger.warn(`[resolveNumbers] Purchase number ${doc.kashflowPurchaseNumber} not found in REST (not yet synced?) for paperlessId=${doc.paperlessId}`);
            }
            notFound++;
            continue;
          }

          await OcrDocument.updateOne(
            { paperlessId: doc.paperlessId },
            { $set: {
              kashflowPurchaseId:     purchase.Id,
              kashflowPurchaseNumber: purchase.Number ?? doc.kashflowPurchaseNumber,
              kashflowPermalink:      purchase.Permalink ?? null,
            }},
          );

          // Best-effort: write the ID back to the Paperless custom field to eliminate drift.
          // Awaited so PATCHes run sequentially — firing them in parallel across the loop
          // overwhelms Paperless-ngx and every PATCH 500s under write contention.
          try {
            await updatePaperlessWithKashFlowInfo(
              doc.paperlessId,
              { Id: purchase.Id, Number: purchase.Number, Permalink: purchase.Permalink },
              doc.lastSendStatus,
              { existingCf: doc.customFields || [] },
            );
          } catch (e) {
            logger.warn(`[resolveNumbers] Paperless CF update failed for paperlessId=${doc.paperlessId}: ${e.message}`);
          }

          logger.info(`[resolveNumbers] Linked paperlessId=${doc.paperlessId} → KF id=${purchase.Id} (number=${purchase.Number})`);
          ok++;
        } catch (e) {
          fail++;
          logger.warn(`[resolveNumbers] Failed for paperlessId=${doc.paperlessId}: ${e.message}`);
        }
      }
      logger.info(`[resolveNumbers] Complete. linked=${ok} notFound=${notFound} failed=${fail}`);
    } catch (err) {
      logger.error(`[resolveNumbers] Fatal error: ${err.message}`);
    } finally {
      _resolveNumbersRunning = false;
    }
  });
};

/** POST /paperless/match-references — for each unlinked KF-eligible doc (with or without a
 *  KashFlow number), cross-check REST purchases by SupplierReference: the send pipeline writes
 *  the doc's invoice-number custom field into the purchase's SupplierReference, so a synced
 *  purchase whose SupplierReference equals that value is almost certainly the created purchase.
 *  A doc is linked only when exactly one candidate purchase survives the safety checks. */
let _matchReferencesRunning = false;
export const matchReferences = async (req, res) => {
  if (_matchReferencesRunning) {
    logger.warn('[matchReferences] Already running — ignoring duplicate request');
    return res.redirect('/overview/documents');
  }
  res.redirect('/overview/documents');
  setImmediate(async () => {
    _matchReferencesRunning = true;
    try {
      await mdb.connect();
      const { OcrDocument } = mdb.PAPERLESS;
      const Purchase = mdb.REST?.purchase;
      if (!Purchase) {
        logger.error('[matchReferences] REST purchase model not available');
        return;
      }

      // Same eligibility rule as the Documents overview: purchases only, no credit notes,
      // no docs tagged as originals that are never entered into KashFlow themselves
      const unlinked = await OcrDocument
        .find({
          kashflowPurchaseId: null,
          'documentType.name': { $regex: /^purchase$/i },
          title: { $not: /credit/i },
          tags: { $not: { $elemMatch: { name: { $in: [/original\/multiple invoice one pdf/i, /credit\/refund/i] } } } },
          deletedInPaperlessAt: null,
        })
        .select('paperlessId title correspondent customFields created lastSendStatus')
        .lean();

      // Purchases already claimed by another doc must not be linked twice
      const claimed = new Set(
        (await OcrDocument.find({ kashflowPurchaseId: { $ne: null } })
          .select('kashflowPurchaseId').lean()
        ).map(d => d.kashflowPurchaseId),
      );

      logger.info(`[matchReferences] Cross-checking ${unlinked.length} unlinked docs against REST purchases by SupplierReference`);

      try {
        await warmCfCache(OcrDocument);
      } catch (cacheErr) {
        logger.warn(`[matchReferences] Could not pre-warm CF cache: ${cacheErr.message}`);
      }

      const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

      let ok = 0, noRef = 0, none = 0, ambiguous = 0, mismatch = 0, fail = 0;
      for (const doc of unlinked) {
        try {
          const draft = buildPurchaseDraftFromOcr(doc);
          const ref = draft.SupplierReference != null ? String(draft.SupplierReference).trim() : '';
          if (!ref) { noRef++; continue; }

          const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let candidates = await Purchase
            .find({
              SupplierReference: { $regex: new RegExp(`^\\s*${escaped}\\s*$`, 'i') },
              deletedAt: null, DeletedAt: null,
            })
            .select('Id Number Permalink SupplierName SupplierReference GrossAmount IssuedDate')
            .lean();
          candidates = candidates.filter(p => !claimed.has(p.Id));

          if (candidates.length === 0) { none++; continue; }

          // Disambiguate / validate: require gross amount within 1p, or failing that a
          // supplier-name match, before trusting a reference collision.
          const gross = typeof draft.GrossAmount === 'number' ? draft.GrossAmount : null;
          const docSupplier = normName(draft.SupplierName);
          const confident = candidates.filter(p => {
            const grossOk = gross != null && typeof p.GrossAmount === 'number'
              && Math.abs(p.GrossAmount - gross) < 0.01;
            const supplierOk = docSupplier && normName(p.SupplierName) === docSupplier;
            return grossOk || supplierOk;
          });
          // A single ref candidate with no comparable amount/supplier data is still accepted —
          // SupplierReference comes from our own send pipeline, so a unique hit is trustworthy.
          const pool = confident.length > 0
            ? confident
            : (candidates.length === 1 && gross == null && !docSupplier ? candidates : []);

          if (pool.length === 0) { mismatch++;
            logger.warn(`[matchReferences] Ref "${ref}" matched ${candidates.length} purchase(s) but amount/supplier disagree for paperlessId=${doc.paperlessId}`);
            continue;
          }
          if (pool.length > 1) { ambiguous++;
            logger.warn(`[matchReferences] Ref "${ref}" is ambiguous (${pool.length} candidates) for paperlessId=${doc.paperlessId}`);
            continue;
          }

          const purchase = pool[0];
          await OcrDocument.updateOne(
            { paperlessId: doc.paperlessId },
            { $set: {
              kashflowPurchaseId:     purchase.Id,
              kashflowPurchaseNumber: purchase.Number ?? null,
              kashflowPermalink:      purchase.Permalink ?? null,
            }},
          );
          claimed.add(purchase.Id);

          // Best-effort: write the ID back to the Paperless custom field to eliminate drift.
          // Awaited so PATCHes run sequentially — parallel PATCHes 500 under write contention.
          try {
            await updatePaperlessWithKashFlowInfo(
              doc.paperlessId,
              { Id: purchase.Id, Number: purchase.Number, Permalink: purchase.Permalink },
              doc.lastSendStatus,
              { existingCf: doc.customFields || [] },
            );
          } catch (e) {
            logger.warn(`[matchReferences] Paperless CF update failed for paperlessId=${doc.paperlessId}: ${e.message}`);
          }

          logger.info(`[matchReferences] Linked paperlessId=${doc.paperlessId} → KF id=${purchase.Id} (number=${purchase.Number}, ref="${ref}")`);
          ok++;
        } catch (e) {
          fail++;
          logger.warn(`[matchReferences] Failed for paperlessId=${doc.paperlessId}: ${e.message}`);
        }
      }
      logger.info(`[matchReferences] Complete. linked=${ok} noRef=${noRef} noMatch=${none} mismatch=${mismatch} ambiguous=${ambiguous} failed=${fail}`);
    } catch (err) {
      logger.error(`[matchReferences] Fatal error: ${err.message}`);
    } finally {
      _matchReferencesRunning = false;
    }
  });
};

/** POST /paperless/repair-drift — bulk write-back KashFlow custom fields to Paperless for drifted docs */
let _repairDriftRunning = false;
export const repairDrift = async (req, res) => {
  if (_repairDriftRunning) {
    logger.warn('[repairDrift] Already running — ignoring duplicate request');
    return res.redirect('/overview/documents');
  }
  res.redirect('/overview/documents');
  setImmediate(async () => {
    _repairDriftRunning = true;
    try {
      await mdb.connect();
      const { OcrDocument } = mdb.PAPERLESS;

      // Use the same aggregation pipeline as the overview drift count to find drifted docs
      const drifted = await OcrDocument.aggregate([
        { $addFields: {
          _cfKfId: {
            $let: {
              vars: {
                found: { $arrayElemAt: [
                  { $filter: {
                    input: { $ifNull: ['$customFields', []] },
                    cond:  { $eq: [
                      { $toLower: { $ifNull: ['$$this.fieldName', ''] } },
                      'kashflow purchase id',
                    ]},
                  }},
                  0,
                ]},
              },
              in: { $ifNull: ['$$found.value', null] },
            },
          },
        }},
        { $match: { deletedInPaperlessAt: null, $or: [
          { kashflowPurchaseId: { $ne: null }, $or: [{ _cfKfId: null }, { _cfKfId: '' }] },
          { kashflowPurchaseId: null, _cfKfId: { $nin: [null, ''] } },
        ]}},
        { $project: {
          paperlessId: 1,
          kashflowPurchaseId: 1,
          kashflowPurchaseNumber: 1,
          kashflowPermalink: 1,
          lastSendStatus: 1,
          customFields: 1,
          _cfKfId: 1,
        }},
      ]);

      logger.info(`[repairDrift] Found ${drifted.length} drifted documents to repair`);

      // Pre-warm the CF definitions cache once — falls back to MongoDB if Paperless /custom_fields/ is unavailable.
      try {
        await warmCfCache(OcrDocument);
      } catch (cacheErr) {
        logger.warn(`[repairDrift] Could not build CF cache from Paperless or MongoDB: ${cacheErr.message}`);
        // Continue anyway — each doc will try its own resolution and fail if needed
      }

      let ok = 0, fail = 0;
      for (const doc of drifted) {
        // Case 2: Paperless has the KashFlow ID but MongoDB doesn't
        // — could be an orphaned doc (purchase deleted) or a failed write-back.
        if (doc.kashflowPurchaseId == null) {
          const cfId = Number(doc._cfKfId);
          if (!Number.isFinite(cfId) || cfId <= 0) {
            logger.warn(`[repairDrift] Case2 invalid cfKfId="${doc._cfKfId}" for paperlessId=${doc.paperlessId}`);
            fail++;
            continue;
          }
          try {
            const Purchase = mdb.REST?.purchase;
            const activePurchase = Purchase
              ? await Purchase.findOne({ Id: cfId, deletedAt: null, DeletedAt: null }).select('Id Number Permalink').lean()
              : null;

            if (activePurchase) {
              // Purchase still exists → restore the MongoDB link
              await OcrDocument.updateOne(
                { paperlessId: doc.paperlessId },
                { $set: {
                  kashflowPurchaseId:     cfId,
                  kashflowPurchaseNumber: activePurchase.Number ?? null,
                  kashflowPermalink:      activePurchase.Permalink ?? null,
                }},
              );
              logger.info(`[repairDrift] Case2 restored link paperlessId=${doc.paperlessId} → KF id=${cfId}`);
            } else {
              // Purchase is gone (orphaned) → clear MongoDB customFields immediately (resolves drift
              // count at once), then attempt Paperless cleanup in the background.
              await OcrDocument.updateOne(
                { paperlessId: doc.paperlessId },
                { $pull: { customFields: { fieldName: { $regex: /^kashflow /i } } } },
              );
              // Best-effort Paperless cleanup — log failure but don't block ok count
              // Awaited so PATCHes run sequentially — parallel PATCHes 500 under write contention.
              try {
                await clearPaperlessKashFlowFields(doc.paperlessId, doc.customFields || []);
              } catch (e) {
                logger.warn(`[repairDrift] Case2 Paperless clear failed for paperlessId=${doc.paperlessId}: ${e.message}`);
              }
              logger.info(`[repairDrift] Case2 cleared orphaned fields for paperlessId=${doc.paperlessId} (KF id=${cfId} not found)`);
            }
            ok++;
          } catch (e) {
            fail++;
            logger.warn(`[repairDrift] Case2 failed for paperlessId=${doc.paperlessId}: ${e.message}`);
          }
          continue;
        }
        try {
          await updatePaperlessWithKashFlowInfo(
            doc.paperlessId,
            { Id: doc.kashflowPurchaseId, Number: doc.kashflowPurchaseNumber, Permalink: doc.kashflowPermalink },
            doc.lastSendStatus,
            { existingCf: doc.customFields || [] },
          );
          // Mirror the written values into MongoDB's customFields so the drift check
          // reflects the fix immediately without waiting for the next grab run
          const cfUpdates = [
            { fieldName: 'KashFlow Purchase Id',        value: String(doc.kashflowPurchaseId) },
            { fieldName: 'KashFlow Purchase Number',    value: doc.kashflowPurchaseNumber != null ? String(doc.kashflowPurchaseNumber) : null },
            { fieldName: 'KashFlow Purchase Permalink', value: doc.kashflowPermalink || null },
            { fieldName: 'KashFlow Last Send Status',   value: doc.lastSendStatus != null ? String(doc.lastSendStatus) : null },
          ].filter(f => f.value != null);
          for (const { fieldName, value } of cfUpdates) {
            await OcrDocument.updateOne(
              { paperlessId: doc.paperlessId, 'customFields.fieldName': fieldName },
              { $set: { 'customFields.$.value': value } },
            ).then(r => {
              if (r.matchedCount === 0) {
                // Field entry doesn't exist in the array yet — push it
                return OcrDocument.updateOne(
                  { paperlessId: doc.paperlessId },
                  { $push: { customFields: { fieldName, value } } },
                );
              }
            });
          }
          ok++;
        } catch (e) {
          fail++;
          logger.warn(`[repairDrift] Failed for paperlessId=${doc.paperlessId}: ${e.message}`);
        }
      }
      logger.info(`[repairDrift] Complete. ok=${ok} failed=${fail}`);
    } catch (err) {
      logger.error(`[repairDrift] Fatal error: ${err.message}`);
    } finally {
      _repairDriftRunning = false;
    }
  });
};

/** POST /paperless/ocr/:paperlessId/sync-fields — write KashFlow fields back to Paperless for one document */
export const syncPaperlessFields = async (req, res, next) => {
  const paperlessId = parseInt(req.params.paperlessId, 10);
  try {
    if (!Number.isFinite(paperlessId)) {
      req.flash('error', 'Invalid paperlessId.');
      return res.redirect('/paperless/ocr');
    }
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;
    const doc = await OcrDocument.findOne({ paperlessId })
      .select('kashflowPurchaseId kashflowPurchaseNumber kashflowPermalink lastSendStatus customFields')
      .lean();
    if (!doc) {
      req.flash('error', 'Document not found.');
      return res.redirect(`/paperless/ocr/${paperlessId}`);
    }
    if (doc.kashflowPurchaseId == null) {
      req.flash('error', 'No KashFlow Purchase Id in MongoDB — nothing to sync.');
      return res.redirect(`/paperless/ocr/${paperlessId}`);
    }
    await updatePaperlessWithKashFlowInfo(
      paperlessId,
      { Id: doc.kashflowPurchaseId, Number: doc.kashflowPurchaseNumber, Permalink: doc.kashflowPermalink },
      doc.lastSendStatus,
      { existingCf: doc.customFields || [] },
    );
    await ingestOnePaperlessDoc(paperlessId);
    req.flash('success', `Paperless custom fields synced for document #${paperlessId}.`);
    res.redirect(`/paperless/ocr/${paperlessId}`);
  } catch (err) {
    logger.error(`syncPaperlessFields error for paperlessId=${paperlessId}: ${err.message}`);
    req.flash('error', `Sync failed: ${err.message}`);
    res.redirect(`/paperless/ocr/${paperlessId}`);
  }
};

/** POST /paperless/ocr/:paperlessId/remove — remove a MongoDB copy of a document that was
 *  deleted in Paperless (flagged by the grab reconciliation). Only allows removal of docs
 *  actually flagged deletedInPaperlessAt, and returns to the Documents overview. */
export const removeDeletedOcrDocument = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument, OcrDocumentIngest } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) {
      return res.status(400).json({ error: 'Invalid paperlessId' });
    }
    const doc = await OcrDocument.findOne({ paperlessId }).select('deletedInPaperlessAt').lean();
    if (!doc) {
      req.flash('error', `Document #${paperlessId} not found in MongoDB.`);
      return res.redirect('/overview/documents');
    }
    if (!doc.deletedInPaperlessAt) {
      req.flash('error', `Document #${paperlessId} still exists in Paperless — not removing. Use the document page to delete it.`);
      return res.redirect('/overview/documents');
    }
    await Promise.all([
      OcrDocument.deleteOne({ paperlessId }),
      OcrDocumentIngest.deleteOne({ paperlessId }),
    ]);
    logger.info(`[paperless] Removed MongoDB copy of Paperless-deleted document paperlessId=${paperlessId}`);
    req.flash('success', `Document #${paperlessId} removed (was deleted in Paperless).`);
    res.redirect('/overview/documents');
  } catch (err) {
    logger.error(`removeDeletedOcrDocument error for paperlessId=${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export const deleteOcrDocument = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument, OcrDocumentIngest } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);
    if (!Number.isFinite(paperlessId)) {
      return res.status(400).json({ error: 'Invalid paperlessId' });
    }
    await Promise.all([
      OcrDocument.deleteOne({ paperlessId }),
      OcrDocumentIngest.deleteOne({ paperlessId }),
    ]);
    logger.info(`[paperless] Deleted OcrDocument + ingest record for paperlessId=${paperlessId}`);
    req.flash('success', `Document #${paperlessId} deleted.`);
    res.redirect('/paperless/ocr');
  } catch (err) {
    logger.error(`deleteOcrDocument error for paperlessId=${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export default { listOcr, readOcr, listIngest, triggerGrab, getPurchaseDraft, saveDraftExtraLines, sendDraftToKashflow, searchSuppliers, createSupplier, reIngestOne, getMatchPurchase, postMatchPurchase, unlinkKashflow, clearOrphans, resolveNumbers, matchReferences, repairDrift, syncPaperlessFields, removeDeletedOcrDocument, deleteOcrDocument };
