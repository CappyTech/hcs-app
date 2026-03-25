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

    res.render(path.join("tailwindcss", "paperless", "read"), {
      title: doc.title || `Doc #${paperlessId}`,
      doc,
      ingest,
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
      // Consider statuses that indicate work in progress
      const runningStatuses = ["running", "in-progress", "working", "grabbing"];
      const runningCount = await OcrDocumentIngest.countDocuments({
        status: { $in: runningStatuses },
      });
      return res.json({ running: runningCount > 0, runningCount, total });
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
      title: `Purchase Draft • #${paperlessId}`,
      paperlessId,
      doc,
      draft,
      suppliers,
      selectedSupplier,
      payloadPreview,
      sources,
      nominalMap,
      sendDirectEnabled: hasDirectAuth,
      sendWebhookEnabled: !!webhookUrl,
      kashflowApiBaseUrl: KF_BASE,
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
    // Rebuild draft server-side to avoid trusting client payload
    const draft = await buildPurchaseDraftById(paperlessId);
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
            },
          );
        } catch (persistErr) {
          logger.warn(
            `Post-send persist (direct) failed for paperlessId=${paperlessId}: ${persistErr.message}`,
          );
        }
        req.flash("success", "Purchase created in KashFlow.");

        updatePaperlessWithKashFlowInfo(
          paperlessId,
          resp.data,
          resp.status,
        ).catch((e) => {
          logger.warn(
            `Async updatePaperlessWithKashFlowInfo failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        });

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

        // Also try to reflect webhook result into Paperless custom fields
        updatePaperlessWithKashFlowInfo(
          paperlessId,
          resp.data,
          resp.status,
        ).catch((e) => {
          logger.warn(
            `Async updatePaperlessWithKashFlowInfo (webhook) failed for paperlessId=${paperlessId}: ${e.message}`,
          );
        });

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
        }
      : {};
    const docs = await Supplier.find(filter)
      .select("uuid Id Code Name IsArchived DefaultNominalCode")
      .limit(limit)
      .lean();
    res.json({ items: docs });
  } catch (err) {
    next(err);
  }
};
