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

export const getInsights = makeGetInsights();

export default { getInsights, makeGetInsights, postRead, postReprocess, getFixture, getReport };
