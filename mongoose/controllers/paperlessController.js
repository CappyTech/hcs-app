'use strict';
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const { grabPaperlessOCR } = require('../services/grabServicePaperless');

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