/**
 * documentReadingController.js — what the invoice reader made of a document,
 * and how well it does overall (documentReadingService).
 *
 *   GET  /paperless/ocr/:paperlessId/insights          JSON for the entry screen:
 *        ?invoiceNumber=…&vat=n,n                      supplier, VAT check, duplicates, layout
 *   POST /paperless/ocr/:paperlessId/read              read the PDF again now
 *   POST /paperless/ocr/:paperlessId/reprocess         ask Paperless to OCR it again
 *   GET  /paperless/ocr/:paperlessId/reading-fixture   the saved invoice as a test fixture (JSON download)
 *   GET  /paperless/reading                            accuracy report
 *   GET  /paperless/reading/supplier/:correspondentId          what's learned for one supplier
 *   POST /paperless/reading/supplier/:correspondentId/teach    JSON {field, box}: "this is where X is"
 *   POST /paperless/reading/supplier/:correspondentId/forget   field (or none: everything)
 *   POST /paperless/reading/supplier/:correspondentId/labels   field + label words
 */

import path from 'path';
import reading from '../services/paperless/documentReadingService.js';
import logger from '../../services/loggerService.js';

const idParam = (req) => {
  const n = Number(req.params.paperlessId);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const entryUrl = (id) => `/paperless/ocr/${id}/entry`;

export function makeGetInsights(deps = {}) {
  const svc = deps.service || reading;
  return async function getInsights(req, res) {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'Not found' });
    try {
      // Only what the reader would make of them: an invoice number and VAT numbers
      const invoiceNumber = typeof req.query.invoiceNumber === 'string' ? req.query.invoiceNumber.slice(0, 60) : null;
      const vatNumbers = typeof req.query.vat === 'string'
        ? req.query.vat.split(',').map((v) => v.replace(/[^0-9A-Za-z]/g, '').slice(0, 14)).filter(Boolean).slice(0, 10)
        : null;
      const out = await svc.insights(id, { invoiceNumber, vatNumbers });
      if (!out) return res.status(404).json({ error: 'Not found' });
      res.set('Cache-Control', 'no-store');
      return res.json(out);
    } catch (err) {
      logger.error(`[documentReading] insights ${id}: ${err.message}`);
      return res.status(500).json({ error: 'Could not check this document.' });
    }
  };
}

export const postRead = async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/paperless/queues');
  try {
    const r = await reading.readDocument(id, { refetch: true });
    if (r?.error) req.flash('error', `Could not read the PDF: ${r.error}`);
    else if (r && !r.hasText) req.flash('error', 'The PDF has no text to read. Ask Paperless to OCR it again.');
    else req.flash('success', 'Read the PDF again.');
  } catch (err) {
    logger.error(`[documentReading] read ${id}: ${err.message}`);
    req.flash('error', 'Could not read the PDF.');
  }
  return res.redirect(entryUrl(id));
};

export const postReprocess = async (req, res) => {
  const id = idParam(req);
  if (!id) return res.redirect('/paperless/queues');
  try {
    await reading.reprocess(id);
    req.flash('success', 'Paperless is running OCR on it again. The text appears here once it has finished, usually within a few minutes.');
  } catch (err) {
    logger.error(`[documentReading] reprocess ${id}: ${err.message}`);
    req.flash('error', 'Paperless did not accept the request to OCR it again.');
  }
  return res.redirect(entryUrl(id));
};

export const getFixture = async (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(404).type('text/plain').send('Not found');
  try {
    const fx = await reading.fixtureFor(id);
    if (!fx) return res.status(404).type('text/plain').send('Nothing saved for this document yet.');
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="invoice-${id}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.send(JSON.stringify(fx, null, 1));
  } catch (err) {
    logger.error(`[documentReading] fixture ${id}: ${err.message}`);
    return res.status(500).type('text/plain').send('Could not build the fixture.');
  }
};

export const getReport = async (req, res, next) => {
  try {
    const report = await reading.accuracyReport();
    res.render(path.join('tailwindcss', 'paperless', 'reading'), {
      title: 'Invoice reading accuracy',
      report,
      fields: reading.HEADER_FIELDS || ['invoiceNumber', 'invoiceDate', 'dueDate', 'totalGoods', 'totalVat', 'invoiceTotal'],
    });
  } catch (err) {
    logger.error(`[documentReading] report: ${err.message}`);
    next(err);
  }
};

const supplierParam = (req) => {
  const n = Number(req.params.correspondentId);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
const supplierUrl = (id) => `/paperless/reading/supplier/${id}`;
const FIELD_LABELS = {
  invoiceNumber: 'Invoice number', invoiceDate: 'Invoice date', dueDate: 'Due date',
  totalGoods: 'Total goods', totalVat: 'Total VAT', invoiceTotal: 'Invoice total',
};

export const getSupplier = async (req, res, next) => {
  try {
    const id = supplierParam(req);
    const detail = id == null ? null : await reading.supplierDetail(id);
    if (!detail) {
      return res.status(404).render(path.join('tailwindcss', 'error'), {
        title: '404 - Not Found',
        error: { title: '404 - Not Found', message: 'Nothing has been read or learned for this supplier yet.' },
      });
    }
    // The invoice to show: ?doc= if it's one of theirs with text, else the latest with text
    const wanted = Number(req.query.doc);
    const withText = detail.documents.filter((d) => d.hasText);
    const shown = withText.find((d) => d.paperlessId === wanted) || withText[0] || null;
    res.render(path.join('tailwindcss', 'paperless', 'supplierReading'), {
      title: `Reading: ${detail.name}`,
      detail,
      shown,
      fields: reading.HEADER_FIELDS,
      fieldLabels: FIELD_LABELS,
    });
  } catch (err) {
    logger.error(`[documentReading] supplier ${req.params.correspondentId}: ${err.message}`);
    next(err);
  }
};

export const postTeach = async (req, res) => {
  const id = supplierParam(req);
  if (id == null) return res.status(404).json({ ok: false, message: 'Not found' });
  try {
    const { field, box, name } = req.body || {};
    const r = await reading.teach(id, String(field || ''), box, { name: typeof name === 'string' ? name.slice(0, 120) : null });
    return res.status(r.ok ? 200 : 400).json(r);
  } catch (err) {
    logger.error(`[documentReading] teach ${id}: ${err.message}`);
    return res.status(500).json({ ok: false, message: 'Could not save that.' });
  }
};

export const postForget = async (req, res) => {
  const id = supplierParam(req);
  if (id == null) return res.redirect('/paperless/reading');
  const field = req.body?.field ? String(req.body.field) : null;
  try {
    const r = await reading.forget(id, field);
    req.flash(r.ok ? 'success' : 'error', r.ok
      ? (field ? `Forgot where ${FIELD_LABELS[field] || field} is.` : 'Forgot everything learned for this supplier.')
      : r.message);
  } catch (err) {
    logger.error(`[documentReading] forget ${id}: ${err.message}`);
    req.flash('error', 'Could not forget that.');
  }
  return res.redirect(supplierUrl(id));
};

export const postLabels = async (req, res) => {
  const id = supplierParam(req);
  if (id == null) return res.redirect('/paperless/reading');
  const field = String(req.body?.field || '');
  try {
    const r = await reading.setLabels(id, field, req.body?.labels ?? '', { name: req.body?.name ? String(req.body.name).slice(0, 120) : null });
    if (!r.ok) req.flash('error', r.message);
    else req.flash('success', r.labels.length
      ? `${FIELD_LABELS[field]}: now also looks for ${r.labels.map((l) => `"${l}"`).join(', ')}.`
      : `${FIELD_LABELS[field]}: removed your label words.`);
  } catch (err) {
    logger.error(`[documentReading] labels ${id}: ${err.message}`);
    req.flash('error', 'Could not save the label words.');
  }
  return res.redirect(`${supplierUrl(id)}#labels`);
};

export const getInsights = makeGetInsights();

export default { getInsights, makeGetInsights, postRead, postReprocess, getFixture, getReport, getSupplier, postTeach, postForget, postLabels };
