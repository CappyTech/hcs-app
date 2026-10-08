/**
 * documentTypeCheck.js — does a document look like its type?
 *
 * The mail rules type each document by the address it was sent to, so a
 * statement sent to purchase@ arrives as a Purchase Invoice, and a manual
 * upload can arrive with no type at all (and so in no queue). This flags
 * those for the "Check the type" queue, from the Paperless OCR text and what
 * the invoice reader found. It only suggests: a person corrects the type, or
 * marks it as right.
 *
 * typeCheck on each OcrDocument: { version, at, concern: {code, message} | null,
 * open, confirmed: {code, at, by} | null }. `open` is what the queue lists:
 * a concern nobody has confirmed, on a document still being worked on.
 * Confirming dismisses that concern only; a different one shows again.
 */

import { isInvoiceDocument } from './documentStateService.js';
import { isDocumentType, documentTypeQuery } from '../../config/paperlessTypesConfig.js';

// Bump when the rules change, so the sweep checks every document again
export const TYPE_CHECK_VERSION = 5; // 2: remittance needs "remittance advice" and no "invoice"; 3: several invoices in one PDF; 4: ignore quoted ("previous") invoice numbers; 5: "Document No." counts too (Beers)

// Untyped documents older than this are history, not work waiting
const UNTYPED_DAYS = 90;
const TOP_CHARS = 800;

const words = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// "Invoice No: 17V1596464", "Invoice Number 260832", "Invoice #INV-0042".
// Credit notes say "Credit Number", so a credit note quoting the invoice it
// credits still counts as one.
const INVOICE_NO = /\binvoice\s*(?:no\.?|number|num\.?|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9/-]{3,})/gi;
// Beers and Duttons print "DOCUMENT No.: I1389496" on a sales invoice (#216).
// Counted on its own, so an invoice with an invoice number and a different
// document number isn't two invoices.
const DOCUMENT_NO = /\bdocument\s*(?:no\.?|number|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9/-]{3,})/gi;
// A number quoted from another invoice, not this one: Smiths Hire prints
// "Previous invoice number 17V1593269" on a continuing hire (#1165)
const QUOTED_BEFORE = /\b(?:previous|prior|original|related|earlier|your|credited|replaces?|against|for)\s*$/i;

/**
 * The distinct invoice numbers printed in `text`, in order. A number repeated
 * on each page of one invoice counts once, and one quoted from another
 * invoice ("Previous invoice number …") doesn't count. Invoice numbers and
 * document numbers are counted apart; the longer list is returned. Pure.
 */
export function invoiceNumbersIn(text) {
  const s = String(text || '');
  const numbers = (re) => {
    const seen = [];
    for (const m of s.matchAll(re)) {
      if (QUOTED_BEFORE.test(s.slice(Math.max(0, m.index - 20), m.index))) continue;
      const n = m[1].toUpperCase().replace(/[-/.]+$/, '');
      if (/\d/.test(n) && !seen.includes(n)) seen.push(n);
    }
    return seen;
  };
  const byInvoice = numbers(INVOICE_NO);
  const byDocument = numbers(DOCUMENT_NO);
  return byDocument.length > byInvoice.length ? byDocument : byInvoice;
}

/**
 * Why `doc` may not be the type it says, or null. Pure.
 * @param {object} doc  { documentType, ocrText, processingState, creditNote, statementReviewed, reading }
 * @returns {{code: string, message: string}|null}
 */
export function typeConcern(doc) {
  if (!doc) return null;
  const type = doc.documentType;
  if (!type || (type.id == null && !type.name)) {
    return { code: 'untyped', message: "It has no document type, so it isn't in any queue." };
  }
  const text = words(doc.ocrText);
  const top = text.slice(0, TOP_CHARS);

  if (isInvoiceDocument(doc)) {
    if (!['awaiting_entry', 'entered'].includes(doc.processingState)) return null;
    // Not just "remittance": invoices say "please email your remittance to" (Travis Perkins)
    if (top && /\bremittance\s+advice\b/i.test(top) && !/\binvoice\b/i.test(top)) {
      return { code: 'looks-remittance', message: 'It reads like a remittance advice ("remittance advice" near the top, no "invoice"), not an invoice.' };
    }
    if (top && /\bstatement\b/i.test(top) && !/\binvoice\b/i.test(top)) {
      return { code: 'looks-statement', message: 'It reads like a supplier statement ("statement" near the top, no "invoice"), not an invoice.' };
    }
    if (top && !doc.creditNote && /\bcredit\s*note\b/i.test(top)) {
      return { code: 'looks-credit-note', message: 'It says "credit note" near the top. If it is one, use Mark as credit note on the entry screen.' };
    }
    // Smiths Hire sends several invoices in one PDF; only the first got entered
    // and the rest never reached KashFlow (#943, #970, #1019, #1035)
    const numbers = doc.excludedReason ? [] : invoiceNumbersIn(text);
    if (numbers.length > 1) {
      const shown = numbers.length > 4 ? `${numbers.slice(0, 4).join(', ')}, …` : numbers.join(', ');
      return {
        code: 'multiple-invoices',
        message: `This PDF holds ${numbers.length} invoices (${shown}). Split it in Paperless so each is entered on its own, `
          + 'and tag this one "original/multiple invoice one pdf".',
      };
    }
    const r = doc.reading;
    if (r && !r.error && r.hasText !== false && !r.fields?.invoiceNumber && !r.fields?.invoiceTotal) {
      return { code: 'nothing-read', message: 'No invoice number or total could be read from it, so it may not be an invoice.' };
    }
    return null;
  }

  if (isDocumentType(type, 'supplierStatement')) {
    if (doc.statementReviewed === true) return null;
    if (top && /\binvoice\b/i.test(top) && !/\bstatement\b/i.test(text)) {
      return { code: 'looks-invoice', message: 'It reads like an invoice ("invoice" near the top, "statement" nowhere), not a supplier statement.' };
    }
  }
  return null;
}

/** Whether `doc` is still being worked on, so a concern about it matters. Pure. */
export function isCheckCandidate(doc, now = new Date()) {
  if (!doc || doc.deletedInPaperlessAt) return false;
  if (['awaiting_entry', 'entered'].includes(doc.processingState)) return true;
  if (isDocumentType(doc.documentType, 'supplierStatement')) return doc.statementReviewed !== true;
  if (!doc.documentType || (doc.documentType.id == null && !doc.documentType.name)) {
    return !!doc.added && now - new Date(doc.added) <= UNTYPED_DAYS * 86_400_000;
  }
  return false;
}

/** The typeCheck to store for `doc` now. Pure. */
export function buildTypeCheck(doc, now = new Date()) {
  const concern = typeConcern(doc);
  const confirmed = doc.typeCheck?.confirmed ?? null;
  const open = !!concern && isCheckCandidate(doc, now) && confirmed?.code !== concern.code;
  return { version: TYPE_CHECK_VERSION, at: now, concern, open, confirmed };
}

const CHECK_FIELDS = 'paperlessId documentType ocrText processingState creditNote excludedReason statementReviewed reading.fields.invoiceNumber reading.fields.invoiceTotal reading.error reading.hasText added deletedInPaperlessAt typeCheck';

const same = (a, b) => a?.version === b.version && a?.open === b.open && (a?.concern?.code ?? null) === (b.concern?.code ?? null);

/** Check one document's type again and store the result when it changed. */
export async function refreshTypeCheck(OcrDocument, paperlessId, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId }).select(CHECK_FIELDS).lean();
  if (!doc) return null;
  const next = buildTypeCheck(doc, now);
  if (!same(doc.typeCheck, next)) {
    await OcrDocument.findOneAndUpdate({ paperlessId }, { $set: { typeCheck: next } }).lean();
  }
  return next;
}

/**
 * Check every document still being worked on, and close checks on ones that
 * have moved on. Catches readings and type changes made since the last run.
 */
export async function sweepTypeChecks(OcrDocument, { now = new Date() } = {}) {
  const since = new Date(now.getTime() - UNTYPED_DAYS * 86_400_000);
  const docs = await OcrDocument.find({
    deletedInPaperlessAt: null,
    $or: [
      { processingState: { $in: ['awaiting_entry', 'entered'] } },
      { $and: [documentTypeQuery('supplierStatement'), { statementReviewed: { $ne: true } }] },
      { 'documentType.id': null, added: { $gte: since } },
      { 'typeCheck.open': true },
    ],
  }).select('paperlessId').lean();
  let open = 0;
  for (const { paperlessId } of docs) {
    const r = await refreshTypeCheck(OcrDocument, paperlessId, { now });
    if (r?.open) open += 1;
  }
  return { checked: docs.length, open };
}

/** "The type is right": dismiss the current concern on `doc`. */
export async function confirmType(OcrDocument, paperlessId, actor, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId }).select('typeCheck documentType').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  const code = doc.typeCheck?.concern?.code;
  if (!code) return { ok: true, changed: false };
  if (code === 'untyped') return { ok: false, reason: 'untyped', message: 'It has no type yet. Choose one instead.' };
  const by = actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null;
  await OcrDocument.findOneAndUpdate({ paperlessId }, {
    $set: { 'typeCheck.confirmed': { code, at: now, by }, 'typeCheck.open': false },
  }).lean();
  return { ok: true, changed: true };
}

export default { TYPE_CHECK_VERSION, typeConcern, invoiceNumbersIn, isCheckCandidate, buildTypeCheck, refreshTypeCheck, sweepTypeChecks, confirmType };
