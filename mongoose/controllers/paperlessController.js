'use strict';
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const axios = require('axios');
const { grabPaperlessOCR } = require('../services/grabServicePaperless');
const { buildPurchaseDraftById, buildKashFlowPayloadFromDraft, defaultMap } = require('../services/paperless/purchaseDraftService');

// Helpers

/** List OCR docs (PAPERLESS DB) */
exports.listOcr = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument } = mdb.PAPERLESS;

    // Filters
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);

    const filter = {};
    if (q) {
      filter.$or = [
        { title: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { ocrText: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { 'correspondent.name': new RegExp(q, 'i') },
        { 'documentType.name': new RegExp(q, 'i') },
      ];
    }

    const total = await OcrDocument.countDocuments(filter);
    const items = await OcrDocument.find(filter)
      .sort({ modified: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    res.render(path.join('tailwindcss', 'paperless',  'list'), {
      title: 'Paperless OCR Documents',
      q, page, pageSize, total,
      items,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) { next(err); }
};

/** Read one OCR doc */
exports.readOcr = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocument, OcrDocumentIngest } = mdb.PAPERLESS;
    const paperlessId = parseInt(req.params.paperlessId, 10);

    const doc = await OcrDocument.findOne({ paperlessId }).lean();
    const ingest = await OcrDocumentIngest.findOne({ paperlessId }).lean();

    if (!doc) return res.status(404).render('error', { message: 'OCR document not found.' });

    res.render(path.join('tailwindcss', 'paperless',  'read'), {
      title: doc.title || `Doc #${paperlessId}`,
      doc, ingest,
    });
  } catch (err) { next(err); }
};

/** List ingest tracker with filters */
exports.listIngest = async (req, res, next) => {
  try {
    await mdb.connect();
    const { OcrDocumentIngest } = mdb.PAPERLESS;

    const status = (req.query.status || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '25', 10), 1), 200);

    const filter = {};
    if (status) filter.status = status;

    const total = await OcrDocumentIngest.countDocuments(filter);

    const items = await OcrDocumentIngest.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    res.render(path.join('tailwindcss', 'paperless',  'ingest'), {
      title: 'Paperless Ingest Tracker',
      status, page, pageSize, total,
      items,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) { next(err); }
};

/** Trigger a background grab (manual) */
exports.triggerGrab = async (req, res, next) => {
  try {
    const since = (req.body.since || '').trim() || null;
    const query = (req.body.query || '').trim() || null;
    const pageSize = parseInt(req.body.pageSize || process.env.PAPERLESS_PAGE_SIZE || '50', 10);
    const concurrency = parseInt(req.body.concurrency || process.env.PAPERLESS_CONCURRENCY || '5', 10);

    const result = await grabPaperlessOCR({ since, query, pageSize, concurrency });
    req.flash && req.flash('success', `Grab complete: processed=${result.processed}, skipped=${result.skipped}, failed=${result.failed}`);
    res.redirect('/paperless/ingest');
  } catch (err) {
    logger.error('Trigger grab error:', err);
    if (req.flash) req.flash('error', `Grab failed: ${err.message}`);
    res.redirect('/paperless/ingest');
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
    if (!doc) return res.status(404).render('error', { message: 'OCR document not found.' });
    const draft = await buildPurchaseDraftById(paperlessId);

    // Determine source field names for key draft values to aid debugging/visibility
    const norm = (s) => String(s || '').trim().toLowerCase();
    const cf = Array.isArray(doc?.customFields) ? doc.customFields : [];
    const cfNameSet = new Map(); // normalized name -> original name
    for (const c of cf) {
      if (c && c.fieldName) cfNameSet.set(norm(c.fieldName), String(c.fieldName));
    }
    const pickSource = (names) => {
      for (const n of (names || [])) {
        const key = norm(n);
        if (cfNameSet.has(key)) return cfNameSet.get(key);
      }
      return null;
    };
    const sources = {
      SupplierReferenceSource: pickSource(defaultMap.SupplierReference),
      IssuedDateSource: pickSource(defaultMap.IssuedDate),
      NetAmountSource: pickSource(defaultMap.NetAmount),
      VATAmountSource: pickSource(defaultMap.VATAmount),
      GrossAmountSource: pickSource(defaultMap.GrossAmount),
    };

    // Supplier suggestions (prefill) and best guess
    let suppliers = [];
    let selectedSupplier = null;
    if (Supplier) {
      const qName = (draft.SupplierName || doc?.correspondent?.name || '').trim();
      if (qName) {
        const safe = qName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        suppliers = await Supplier.find({
          $or: [
            { Name: new RegExp(safe, 'i') },
            { Code: new RegExp(safe, 'i') },
          ],
        }).select('uuid Id Code Name IsArchived DefaultNominalCode').limit(10).lean();
        // exact case-insensitive match preference
        const nameLower = qName.toLowerCase();
        selectedSupplier = suppliers.find(s => (s.Name||'').toLowerCase() === nameLower || (s.Code||'').toLowerCase() === nameLower) || null;
      } else {
        suppliers = await Supplier.find({}).select('uuid Id Code Name IsArchived DefaultNominalCode').sort({ updatedAt: -1 }).limit(10).lean();
      }
    }
    // Build a Nominal map by Code for display (description/name) in draft view
    const Nominal = mdb.REST && mdb.REST.nominal;
    let nominalMap = {};
    if (Nominal) {
      // Fetch only nominals classified as "Purchases" so the per-line dropdown shows valid purchase accounts
      try {
        const docs = await Nominal.find({ Classification: 'Purchases' })
          .select('Code Name Description Classification')
          .sort({ Code: 1 })
          .lean();
        nominalMap = (docs || []).reduce((acc, n) => {
          if (n && typeof n.Code === 'number') acc[n.Code] = { Name: n.Name || null, Description: n.Description || null };
          return acc;
        }, {});
      } catch (e) {
        logger.warn('Failed to load nominal map for draft view: ' + e.message);
      }
    }

    const payloadPreview = (() => {
      try { return buildKashFlowPayloadFromDraft(draft); } catch (_) { return null; }
    })();
    res.render(path.join('tailwindcss', 'paperless', 'draft'), {
      title: `Purchase Draft • #${paperlessId}`,
      paperlessId,
      doc,
      draft,
      suppliers,
      selectedSupplier,
      payloadPreview,
      sources,
      nominalMap,
    });
  } catch (err) {
    logger.error('getPurchaseDraft error:', err);
    next(err);
  }
};

/** Handle POST to send the draft to KashFlow (placeholder – external integration lives elsewhere) */
exports.sendDraftToKashflow = async (req, res, next) => {
  try {
    const paperlessId = parseInt(req.params.paperlessId, 10);
    const dryRun = String(req.body?.dryRun ?? 'true').toLowerCase() === 'true';
    // Rebuild draft server-side to avoid trusting client payload
    const draft = await buildPurchaseDraftById(paperlessId);
    // If a supplier is selected, merge its identifiers
    const supplierUuid = (req.body && req.body.supplierUuid) ? String(req.body.supplierUuid).trim() : '';
    if (supplierUuid) {
      const Supplier = mdb.REST && mdb.REST.supplier;
      if (Supplier) {
        const s = await Supplier.findOne({ uuid: supplierUuid }).lean();
        if (s) {
          draft.SupplierId = typeof s.Id === 'number' ? s.Id : undefined;
          draft.SupplierCode = s.Code || draft.SupplierCode;
          draft.SupplierName = s.Name || draft.SupplierName;
          if (typeof s.DefaultNominalCode === 'number') {
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
        const allowed = await Nominal.find({ Classification: 'Purchases' }).select('Code').lean();
        allowedNominalCodes = new Set((allowed || []).map(n => n && typeof n.Code === 'number' ? n.Code : undefined).filter(v => v !== undefined));
      }
    } catch (e) {
      logger.warn('Failed to load allowed nominal codes for send validation: ' + e.message);
    }
    // Apply per-line nominal codes posted from the draft view (nominalCodes[])
    // Accept both nominalCodes[] and nominalCodes to be robust to body parsers
    const postedNominalRaw = (req.body && (req.body['nominalCodes[]'] ?? req.body.nominalCodes)) ?? [];
    const postedNominals = Array.isArray(postedNominalRaw)
      ? postedNominalRaw
      : (typeof postedNominalRaw === 'string' ? [postedNominalRaw] : []);
    if (Array.isArray(draft.LineItems) && draft.LineItems.length > 0 && postedNominals.length > 0) {
      for (let i = 0; i < draft.LineItems.length && i < postedNominals.length; i++) {
        const li = draft.LineItems[i] || {};
        const raw = postedNominals[i];
        if (raw == null) continue; // nothing provided for this line
        const txt = String(raw).trim();
        if (txt === '') {
          // Explicit empty => remove per-line nominal so supplier default (if any) applies
          if ('NominalCode' in li) delete li.NominalCode;
          continue;
        }
        const code = parseInt(txt, 10);
        if (Number.isFinite(code) && (!allowedNominalCodes || allowedNominalCodes.has(code))) {
          li.NominalCode = code;
        } else {
          // Invalid value -> clear to allow default fallback
          if ('NominalCode' in li) delete li.NominalCode;
        }
        draft.LineItems[i] = li;
      }
    }
    const payload = buildKashFlowPayloadFromDraft(draft);
    const webhookUrl = process.env.KASHFLOW_CREATOR_WEBHOOK_URL;
    const webhookToken = process.env.KASHFLOW_CREATOR_WEBHOOK_TOKEN;

    if (dryRun || !webhookUrl) {
      // Simulated send (or not configured) – log payload and inform user
      logger.info(`[kashflow] DRY-RUN create Purchase for paperlessId=${paperlessId}${!webhookUrl ? ' (no webhook configured)' : ''}`, { payload });
      if (req.flash) req.flash('success', `Dry run only${!webhookUrl ? ' (webhook not configured)' : ''}. No data sent.`);
    } else {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (webhookToken) headers['Authorization'] = `Bearer ${webhookToken}`;
        const resp = await axios.post(webhookUrl, { type: 'purchase.create', paperlessId, payload }, { headers, timeout: 15000 });
        logger.info(`[kashflow] Sent create Purchase for paperlessId=${paperlessId}. status=${resp.status}`);
        if (req.flash) req.flash('success', 'Draft sent to KashFlow creator webhook.');
      } catch (sendErr) {
        logger.error(`[kashflow] Send failed for paperlessId=${paperlessId}: ${sendErr.message}`);
        if (req.flash) req.flash('error', `Send failed: ${sendErr.message}`);
      }
    }
    res.redirect(`/paperless/ocr/${paperlessId}/draft`);
  } catch (err) {
    logger.error('sendDraftToKashflow error:', err);
    if (req.flash) req.flash('error', `Send failed: ${err.message}`);
    res.redirect('back');
  }
};

/** JSON supplier search: GET /paperless/suppliers?q=&limit= */
exports.searchSuppliers = async (req, res, next) => {
  try {
    await mdb.connect();
    const Supplier = mdb.REST && mdb.REST.supplier;
    if (!Supplier) return res.status(501).json({ error: 'Supplier model unavailable' });
    const q = String(req.query.q || '').trim();
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const filter = q ? {
      $or: [
        { Name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { Code: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      ],
    } : {};
  const docs = await Supplier.find(filter).select('uuid Id Code Name IsArchived DefaultNominalCode').limit(limit).lean();
    res.json({ items: docs });
  } catch (err) { next(err); }
};