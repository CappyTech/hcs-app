"use strict";

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

const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const logger = require("../../services/loggerService");
const axios = require("axios");
const {
  grabPaperlessOCR,
  ingestOnePaperlessDoc,
  isGrabRunning,
} = require("../services/grabServicePaperless");
const {
  buildPurchaseDraftById,
  buildKashFlowPayloadFromDraft,
  defaultMap,
} = require("../services/paperless/purchaseDraftService");
const {
  updatePaperlessWithKashFlowInfo,
  updatePaperlessDocumentTags,
} = require("../services/paperless/paperlessUpdateService");

// Helpers

/** List OCR docs (PAPERLESS DB) */
exports.listOcr = async (req, res, next) => {
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
      items,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      startedBgIngest,
    });
  } catch (err) {
    next(err);
  }
};

/** Read one OCR doc */
exports.readOcr = async (req, res, next) => {
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

    res.render(path.join("tailwindcss", "paperless", "read"), {
      title: doc.title || `Doc #${paperlessId}`,
      doc,
      ingest,
      hasDrift,
      cfKashflowPurchaseId,
    });
  } catch (err) {
    next(err);
  }
};

/** List ingest tracker with filters */
exports.listIngest = async (req, res, next) => {
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
exports.triggerGrab = async (req, res, next) => {
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
exports.getPurchaseDraft = async (req, res, next) => {
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
    const isSubcontractor = /subcontract/i.test(doc?.documentType?.name || "");
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

/** Handle POST to send the draft to KashFlow (placeholder – external integration lives elsewhere) */
exports.sendDraftToKashflow = async (req, res, next) => {
  try {
    const paperlessId = parseInt(req.params.paperlessId, 10);
    // Checkbox semantics: when unchecked, field is absent -> treat as false
    const dryRun = ["true", "on", "1", "yes"].includes(
      String(req.body?.dryRun || "").toLowerCase(),
    );

    // Server-side idempotency check — reject if already linked to KashFlow
    if (!dryRun) {
      await mdb.connect();
      const { OcrDocument } = mdb.PAPERLESS;
      const existingDoc = await OcrDocument.findOne({ paperlessId }).select('kashflowPurchaseId lastSendStatus').lean();
      if (existingDoc?.kashflowPurchaseId && existingDoc?.lastSendStatus === 201) {
        req.flash('error', `This document is already linked to KashFlow purchase #${existingDoc.kashflowPurchaseId}. Unlink it first before re-sending.`);
        return res.redirect(`/paperless/ocr/${paperlessId}/draft`);
      }
    }

    // Rebuild draft server-side to avoid trusting client payload
    await mdb.connect();
    const draft = await buildPurchaseDraftById(paperlessId);
    // Detect document type for subcontractor mode
    const { OcrDocument: OcrDocumentSend } = mdb.PAPERLESS;
    const sendDoc = await OcrDocumentSend.findOne({ paperlessId }).select('documentType customFields').lean();
    const isSubcontractor = /subcontract/i.test(sendDoc?.documentType?.name || "");
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
    const kfSession = require("../../services/kashflowSessionService");
    const kfVat = require("../../services/kashflowVatService");
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
          return axios.post(url, payload, { headers, timeout: 20000 });
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
          const purchaseId =
            resp?.data && typeof resp.data.Id === "number"
              ? resp.data.Id
              : null;
          const purchaseNumber =
            resp?.data && typeof resp.data.Number === "number"
              ? resp.data.Number
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
          const purchaseId = typeof body?.Id === "number" ? body.Id : null;
          const purchaseNumber =
            typeof body?.Number === "number" ? body.Number : null;
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
exports.searchSuppliers = async (req, res, next) => {
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

/** POST /paperless/ocr/:paperlessId/ingest — re-ingest a single document from Paperless */
exports.reIngestOne = async (req, res, next) => {
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
    next(err);
  }
};

/** POST /paperless/ocr/:paperlessId/unlink — clear stale KashFlow linkage */
exports.unlinkKashflow = async (req, res, next) => {
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
      const { makeClient } = require('../services/paperless/paperlessClient');
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

/** DELETE /paperless/ocr/:paperlessId — remove an OcrDocument (and its ingest record) */
/** POST /paperless/repair-drift — bulk write-back KashFlow custom fields to Paperless for drifted docs */
exports.repairDrift = async (req, res) => {
  res.redirect('/overview/documents');
  setImmediate(async () => {
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
        { $match: { $or: [
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
      let ok = 0, fail = 0;
      for (const doc of drifted) {
        // Only write-back for linked docs (MongoDB has ID but Paperless doesn't)
        if (doc.kashflowPurchaseId == null) continue;
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
    }
  });
};

exports.deleteOcrDocument = async (req, res, next) => {
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
