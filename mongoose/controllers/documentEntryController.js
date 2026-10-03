/**
 * documentEntryController.js — the document entry screen (Paperless
 * migration H5): the PDF beside a form chosen by document type, the OCR text,
 * and the Complete entry / Credit Note / Reopen actions.
 *
 *   GET  /paperless/ocr/:paperlessId/entry        entry screen
 *   POST /paperless/ocr/:paperlessId/entry        save | addLine | complete
 *   POST /paperless/ocr/:paperlessId/credit-note  flag=on|off
 *   POST /paperless/ocr/:paperlessId/reopen       admin: back to Needs Data Entry
 *   GET  /paperless/ocr/:paperlessId/file         the PDF, streamed from Paperless
 */

import path from 'path';
import { pipeline } from 'node:stream/promises';
import mdb from '../services/mongooseDatabaseService.js';
import entry from '../services/paperless/documentEntryService.js';
import { actorFromUser } from '../services/paperless/documentStateService.js';
import { paperlessUiBase } from '../services/paperless/documentQueueService.js';
import __paperlessClient from '../services/paperless/paperlessClient.js';
import logger from '../../services/loggerService.js';

const notFound = (res, message = 'Document not found.') => res.status(404).render(path.join('tailwindcss', 'error'), {
  title: '404 - Not Found',
  error: { title: '404 - Not Found', message },
});

const idParam = (req) => {
  const n = Number(req.params.paperlessId);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const entryUrl = (id) => `/paperless/ocr/${id}/entry`;

async function loadDoc(paperlessId) {
  await mdb.connect();
  const { OcrDocument } = mdb.PAPERLESS;
  return { OcrDocument, doc: await OcrDocument.findOne({ paperlessId }).lean() };
}

function render(req, res, doc, { values = null, errors = {}, status = 200, extraLines = 0 } = {}) {
  const kind = entry.entryKind(doc);
  const v = values || entry.formValues(doc);
  const lineCount = Math.max((v.lines || []).length, 1) + extraLines;
  res.status(status).render(path.join('tailwindcss', 'paperless', 'entry'), {
    title: doc.title || `Document #${doc.paperlessId}`,
    doc,
    kind,
    values: v,
    lineCount,
    errors,
    warnings: kind === 'invoice' ? entry.consistencyWarnings(doc.entry) : [],
    isAdmin: req.user?.role === 'admin',
    locked: doc.processingState === 'sent',
    paperlessUiBase: paperlessUiBase(),
  });
}

export const getEntry = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    let { OcrDocument, doc } = await loadDoc(id);
    if (!doc) return notFound(res);
    // Documents from before the webhook get their first state here
    if (!doc.processingState && !doc.classifiedAt && !doc.deletedInPaperlessAt) {
      const c = await entry.ensureClassified(OcrDocument, id);
      if (c.classified) doc = await OcrDocument.findOne({ paperlessId: id }).lean();
    }
    render(req, res, doc, { extraLines: req.query.extraLines === '1' ? 1 : 0 });
  } catch (err) {
    logger.error(`[documentEntry] GET ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export const postEntry = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    const { OcrDocument, doc } = await loadDoc(id);
    if (!doc) return notFound(res);
    const kind = entry.entryKind(doc);
    const action = ['save', 'addLine', 'complete'].includes(req.body.action) ? req.body.action : 'save';
    const actor = actorFromUser(req.user);

    const { entry: parsed, errors } = entry.parseEntryForm(req.body, kind);
    if (Object.keys(errors).length) {
      // Show the form again with what was typed, not what was saved
      const values = kind === 'bank'
        ? { source: 'form', bank: req.body.bank || {} }
        : { source: 'form', ...req.body, lines: Array.isArray(req.body.lines) ? req.body.lines : Object.values(req.body.lines || {}) };
      return render(req, res, doc, { values, errors, status: 422 });
    }

    const saved = await entry.saveEntry(OcrDocument, id, parsed, actor);
    if (!saved.ok) {
      req.flash('error', saved.message);
      return res.redirect(entryUrl(id));
    }

    if (action === 'addLine') return res.redirect(`${entryUrl(id)}?extraLines=1#lines`);

    if (action === 'complete') {
      const done = await entry.completeEntry(OcrDocument, id, actor);
      if (!done.ok) {
        if (done.reason === 'incomplete') {
          return render(req, res, saved.doc, { errors: done.errors, status: 422 });
        }
        req.flash('error', done.message);
        return res.redirect(entryUrl(id));
      }
      req.flash('success', `Entry complete for "${doc.title || id}". It's now in Ready for KashFlow.`);
      if (done.paperlessWarning) req.flash('error', done.paperlessWarning);
      return res.redirect('/paperless/queues/needs-entry');
    }

    req.flash('success', 'Saved.');
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] POST ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export const postCreditNote = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    await mdb.connect();
    const flag = req.body.flag === 'on';
    const r = await entry.setCreditNote(mdb.PAPERLESS.OcrDocument, id, flag, actorFromUser(req.user));
    if (!r.ok) {
      req.flash('error', r.message);
    } else {
      req.flash('success', flag
        ? 'Marked as a credit note. It leaves both invoice queues and is keyed into KashFlow by hand.'
        : 'No longer a credit note. It is back in Needs Data Entry.');
      if (r.paperlessWarning) req.flash('error', r.paperlessWarning);
    }
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] credit-note ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export const postReopen = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    await mdb.connect();
    const r = await entry.reopenEntry(mdb.PAPERLESS.OcrDocument, id, actorFromUser(req.user));
    if (!r.ok) {
      req.flash('error', r.message);
    } else {
      req.flash('success', 'Reopened. It is back in Needs Data Entry.');
      if (r.paperlessWarning) req.flash('error', r.paperlessWarning);
    }
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] reopen ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

/**
 * Stream the PDF from Paperless. Paperless stays the only file store: nothing
 * is written to disk, and the browser never sees the Paperless token.
 */
export function makeGetFile(deps = {}) {
  const getClient = deps.makeClient ?? (() => __paperlessClient.makeClient());
  return async function getFile(req, res) {
    const id = idParam(req);
    if (!id) return res.status(404).type('text/plain').send('Not found');
    let file;
    try {
      file = await getClient().getDocumentFile(id);
    } catch (err) {
      const status = err?.response?.status === 404 ? 404 : 502;
      logger.warn(`[documentEntry] file ${id}: ${err.message}`);
      return res.status(status).type('text/plain').send(status === 404 ? 'Not found in Paperless' : 'Could not fetch the file from Paperless');
    }
    res.status(200);
    res.set({
      'Content-Type': /pdf/i.test(file.contentType) ? 'application/pdf' : file.contentType,
      'Content-Disposition': `inline; filename="document-${id}.pdf"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    if (file.contentLength != null) res.set('Content-Length', String(file.contentLength));
    try {
      await pipeline(file.stream, res);
    } catch (err) {
      logger.warn(`[documentEntry] file ${id} stream ended early: ${err.message}`);
      if (!res.headersSent) res.status(502).end();
    }
  };
}

export const getFile = makeGetFile();

export default { getEntry, postEntry, postCreditNote, postReopen, getFile, makeGetFile };
