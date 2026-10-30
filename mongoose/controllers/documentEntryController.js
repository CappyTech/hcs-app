/**
 * documentEntryController.js — the document entry screen (Paperless
 * migration H5): the PDF beside a form chosen by document type, the OCR text,
 * and the Complete entry / Credit Note / Reopen actions.
 *
 *   GET  /paperless/ocr/:paperlessId/entry        entry screen
 *   POST /paperless/ocr/:paperlessId/entry        save | addLine | complete
 *   POST /paperless/ocr/:paperlessId/credit-note  flag=on|off
 *   POST /paperless/ocr/:paperlessId/not-for-kashflow  flag=on (note) | off (admin)
 *   POST /paperless/ocr/:paperlessId/reopen       admin: back to Needs Data Entry
 *   POST /paperless/ocr/:paperlessId/resend-invoice  re-send the invoice email (H6)
 *   POST /paperless/ocr/:paperlessId/reviewed     mark a supplier statement reviewed (H6)
 *   POST /paperless/ocr/:paperlessId/statement-check  set a supplier statement against KashFlow again
 *   POST /paperless/ocr/:paperlessId/supplier     set the KashFlow supplier (the Paperless correspondent)
 *   GET  /paperless/ocr/:paperlessId/file         the PDF, streamed from Paperless
 */

import path from 'path';
import { pipeline } from 'node:stream/promises';
import mdb from '../services/mongooseDatabaseService.js';
import entry from '../services/paperless/documentEntryService.js';
import { actorFromUser, notForEntryMessage } from '../services/paperless/documentStateService.js';
import { paperlessUiBase } from '../services/paperless/documentQueueService.js';
import notifySvc from '../services/paperless/documentNotifyService.js';
import readingSvc from '../services/paperless/documentReadingService.js';
import statementSvc from '../services/paperless/statementReadingService.js';
import { documentTypeOptions } from '../services/paperless/documentTypeService.js';
import supplierSvc from '../services/paperless/documentSupplierService.js';
import __paperlessClient from '../services/paperless/paperlessClient.js';
import { parseCorrespondentName } from '../services/paperless/correspondentName.js';
import { normaliseVatNumber } from '../../public/js/invoice-line-finder.js';
import * as organisation from '../../services/organisationService.js';
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

/**
 * The supplier's CIS rate for a subcontractor invoice, matched by name or
 * code as the draft does, and the deduction on the labour shown.
 * Null for other documents; { supplier: null } when there's no match.
 */
async function kashflowSupplier(doc) {
  return readingSvc.supplierFor(mdb.REST && mdb.REST.supplier, doc.correspondent?.name).catch(() => null);
}

/**
 * For a subcontractor invoice: the CIS deduction at the KashFlow supplier's
 * rate, and which VAT case it is (vatCase). Null for other documents.
 */
/** VAT numbers read off the document, leaving out our own (printed as the customer's). */
function supplierVatNumbers(doc) {
  const own = normaliseVatNumber(organisation.companyVatNumber());
  return [...new Set((doc.reading?.vatNumbers || []).map((v) => normaliseVatNumber(v.number)).filter((n) => n && n !== own))];
}

/** Us, as an invoice should name us: from Admin → Configuration → Organisation. */
function companyForChecks() {
  const configured = organisation.companyName() !== 'This company';
  return {
    names: configured ? [...new Set([organisation.companyName(), organisation.companyShortName()])] : [],
    address: organisation.companyAddress(),
  };
}

async function subcontractorChecks(doc, values) {
  if (!entry.isSubcontractorEntry(doc)) return { cis: null, vat: null };
  const s = await kashflowSupplier(doc);
  const vat = entry.vatCase({
    supplier: s,
    docVatNumbers: supplierVatNumbers(doc),
    ocrText: doc.ocrText,
    totalVat: values.totalVat,
    lines: values.lines,
  });
  if (!s) return { cis: { supplier: null }, vat };
  return { cis: { supplier: s.Name, ...(entry.cisDeduction(values, s.WithholdingTaxRate) || {}) }, vat };
}

async function render(req, res, doc, { values = null, errors = {}, status = 200, extraLines = 0 } = {}) {
  const kind = entry.entryKind(doc);
  const subcontractor = entry.isSubcontractorEntry(doc);
  const v = values || entry.formValues(doc);
  const lineCount = Math.max((v.lines || []).length, 1) + extraLines;
  const hints = kind === 'invoice' ? await readingSvc.hintsFor(doc).catch(() => null) : null;
  const isAdmin = req.user?.role === 'admin';
  const notifications = await notifySvc.historyFor(mdb.PAPERLESS?.NotificationLog, doc.paperlessId).catch(() => []);
  res.status(status).render(path.join('tailwindcss', 'paperless', 'entry'), {
    title: doc.title || `Document #${doc.paperlessId}`,
    reading: doc.reading || null,
    // Not `layout`: express-ejs-layouts reads that as the layout file to render
    readerLayout: hints?.layout || null,
    labels: hints?.labels || null,
    doc,
    kind,
    subcontractor,
    ...(await subcontractorChecks(doc, v)),
    values: v,
    lineCount,
    errors,
    warnings: kind === 'invoice' ? entry.consistencyWarnings(doc.entry) : [],
    // What an invoice legally needs that this one doesn't seem to show
    legal: kind === 'invoice' ? entry.invoiceProblems({
      ocrText: doc.ocrText, reading: doc.reading, docVatNumbers: supplierVatNumbers(doc), values: v, company: companyForChecks(),
    }) : [],
    isAdmin,
    // Tagged in Paperless as not for entry: shown, but nothing to enter
    excluded: notForEntryMessage(doc),
    locked: doc.processingState === 'sent' || !!notForEntryMessage(doc),
    paperlessUiBase: paperlessUiBase(),
    notifications,
    // The Audit log tab, admins only
    audit: isAdmin ? entry.auditTimeline(doc, notifications) : null,
    notifyMode: notifySvc.notifyMode(),
    documentTypes: await documentTypeOptions().catch(() => []),
    // The KashFlow supplier picker, for anything with a supplier
    supplierOptions: kind === 'invoice' || kind === 'statement'
      ? await supplierSvc.supplierOptions(mdb.REST && mdb.REST.supplier).catch(() => [])
      : [],
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
    // Read it on the server too, once, for the queue and for learning the supplier's layout
    if (entry.entryKind(doc) === 'invoice' && (!doc.reading || doc.reading.version < readingSvc.READER_VERSION)) {
      readingSvc.readSoon(id).catch(() => {});
    }
    // A statement is set against KashFlow from its OCR text, which is quick, so it's done before the page shows
    if (entry.entryKind(doc) === 'statement' && statementSvc.needsReading(doc) && !doc.deletedInPaperlessAt) {
      const statement = await statementSvc.readStatementSoon(id);
      if (statement) doc = { ...doc, statement };
    }
    await render(req, res, doc, { extraLines: req.query.extraLines === '1' ? 1 : 0 });
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
    const excluded = notForEntryMessage(doc);
    if (excluded) {
      req.flash('error', excluded);
      return res.redirect(entryUrl(id));
    }
    const action = ['save', 'addLine', 'complete'].includes(req.body.action) ? req.body.action : 'save';
    const actor = actorFromUser(req.user);

    const { entry: parsed, errors } = entry.parseEntryForm(req.body, kind, { subcontractor: entry.isSubcontractorEntry(doc) });
    if (Object.keys(errors).length) {
      // Show the form again with what was typed, not what was saved
      const values = kind === 'bank'
        ? { source: 'form', bank: req.body.bank || {} }
        : { source: 'form', ...req.body, lines: Array.isArray(req.body.lines) ? req.body.lines : Object.values(req.body.lines || {}) };
      return await render(req, res, doc, { values, errors, status: 422 });
    }

    const saved = await entry.saveEntry(OcrDocument, id, parsed, actor);
    if (!saved.ok) {
      req.flash('error', saved.message);
      return res.redirect(entryUrl(id));
    }

    // Learn where this supplier puts each value, after the response has gone
    if (kind === 'invoice') setImmediate(() => { readingSvc.learnFromSave(id).catch(() => {}); });

    if (action === 'addLine') return res.redirect(`${entryUrl(id)}?extraLines=1#lines`);

    if (action === 'complete') {
      const done = await entry.completeEntry(OcrDocument, id, actor);
      if (!done.ok) {
        if (done.reason === 'incomplete') {
          return await render(req, res, saved.doc, { errors: done.errors, status: 422 });
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

/** POST /paperless/ocr/:paperlessId/not-for-kashflow  flag=on (with note) | off (admin) */
export const postNotForKashflow = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    const flag = req.body.flag === 'on';
    if (!flag && req.user?.role !== 'admin') {
      req.flash('error', 'Only an admin can undo Not for KashFlow.');
      return res.redirect(entryUrl(id));
    }
    await mdb.connect();
    const r = await entry.setNotForKashflow(mdb.PAPERLESS.OcrDocument, id, { flag, note: req.body.note }, actorFromUser(req.user));
    if (!r.ok) {
      req.flash('error', r.message);
    } else {
      req.flash('success', flag
        ? "Marked not for KashFlow. It's out of both queues and won't be entered or sent."
        : 'No longer marked not for KashFlow. It is back in its queue.');
      if (r.paperlessWarning) req.flash('error', r.paperlessWarning);
    }
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] not-for-kashflow ${req.params.paperlessId}: ${err.message}`);
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

export const postResendInvoice = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    await mdb.connect();
    const r = await entry.resendInvoice(mdb.PAPERLESS.OcrDocument, id, actorFromUser(req.user));
    if (!r.ok) {
      req.flash('error', r.message);
    } else {
      req.flash('success', r.notification?.status === 'sent'
        ? 'Invoice email re-sent.'
        : 'Re-send requested. Paperless sends the invoice email until cutover.');
      if (r.paperlessWarning) req.flash('error', r.paperlessWarning);
    }
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] resend-invoice ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

/** POST /paperless/ocr/:paperlessId/supplier  supplier="<Name> (<Code>)" from the picker */
export const postSupplier = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    await mdb.connect();
    const { code } = parseCorrespondentName(req.body.supplier);
    const r = await supplierSvc.assignSupplier(
      { OcrDocument: mdb.PAPERLESS.OcrDocument, Supplier: mdb.REST && mdb.REST.supplier },
      id, code || req.body.supplier, actorFromUser(req.user),
    );
    if (!r.ok) req.flash('error', r.message);
    else if (r.changed) req.flash('success', `Supplier set to ${r.to}, here and in Paperless.`);
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] supplier ${req.params.paperlessId}: ${err.message}`);
    req.flash('error', `Couldn't set the supplier in Paperless: ${err.message}`);
    return res.redirect(entryUrl(Number(req.params.paperlessId) || ''));
  }
};

export const postStatementCheck = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    await mdb.connect();
    const statement = await statementSvc.readStatement(id);
    if (!statement) req.flash('error', 'Only supplier statements can be set against KashFlow.');
    else if (statement.error) req.flash('error', `Couldn't read the statement: ${statement.error}`);
    else req.flash('success', `Set against KashFlow: ${statement.summaryText || 'done'}.`);
    return res.redirect(entryUrl(id));
  } catch (err) {
    logger.error(`[documentEntry] statement-check ${req.params.paperlessId}: ${err.message}`);
    next(err);
  }
};

export const postReviewed = async (req, res, next) => {
  try {
    const id = idParam(req);
    if (!id) return notFound(res);
    await mdb.connect();
    const r = await entry.markReviewed(mdb.PAPERLESS.OcrDocument, id, actorFromUser(req.user));
    if (!r.ok) req.flash('error', r.message);
    else req.flash('success', r.firstTime ? 'Marked reviewed.' : 'It was already marked reviewed.');
    return res.redirect('/paperless/queues/statements');
  } catch (err) {
    logger.error(`[documentEntry] reviewed ${req.params.paperlessId}: ${err.message}`);
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

export default { getEntry, postEntry, postCreditNote, postNotForKashflow, postReopen, postResendInvoice, postReviewed, postStatementCheck, postSupplier, getFile, makeGetFile };
