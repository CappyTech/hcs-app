/**
 * documentEntryService.js — data entry on the hcs-app entry screen
 * (Paperless migration H5; PB-2, PB-4, PB-5, PB-9, PB-12).
 *
 * Entered values are stored on OcrDocument.entry and nowhere else: they are
 * not written to the Paperless custom fields (decision 3 Oct 2026). The
 * KashFlow draft reads them first through entryAsCustomFields() and falls
 * back to the Paperless fields for anything left blank.
 *
 * The two actions that change a document's state also tell Paperless, so its
 * workflows keep sending the emails until cutover (H8):
 *
 *   Complete entry   awaiting_entry → entered, then adds `data entry done`  (WF3 emails John)
 *   Credit note on   → manual_kashflow, then sets Credit Note = true         (WF5 emails Bev)
 *   Credit note off  → awaiting_entry (admin), then sets Credit Note = false
 *   Reopen entry     entered → awaiting_entry (admin), removes `data entry done`
 *
 * The state change is made first and is what counts. If Paperless then can't
 * be updated, the action still succeeds and returns a `paperlessWarning`
 * saying what to do by hand.
 */

import { transition, isInvoiceDocument, markStatementReviewed, notForEntryMessage, setExcludedReason } from './documentStateService.js';
import { notifySafely } from './documentNotifyService.js';
import { classifyDocument } from './documentIngestService.js';
import { isDocumentType } from '../../config/paperlessTypesConfig.js';
import __paperlessUpdateService from './paperlessUpdateService.js';
import __kfSendClaim from './kashflowSendClaimService.js';
import __paperlessClient from './paperlessClient.js';
import logger from '../../../services/loggerService.js';
import { entryAsCustomFields } from './entryOverlay.js';
import { parseVatRate, vatRateProblem } from '../../../public/js/entry-checks.js';

export { entryAsCustomFields };

const { modifyPaperlessDocumentTags } = __paperlessUpdateService;

// ── Parsing ───────────────────────────────────────────────────────────

const INVALID = Symbol('invalid');

const roundTo = (n, dp) => {
  const f = 10 ** dp;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
};

/**
 * '', 'GBP123.45', '£1,234.50', '-12', 12 → number | null | INVALID.
 * Amounts are pennies; a unit price may carry more places (`dp: 4`).
 */
export function parseMoneyInput(v, { dp = 2 } = {}) {
  if (typeof v === 'number') return Number.isFinite(v) ? roundTo(v, dp) : INVALID;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/^[A-Z]{3}/i, '').replace(/[£$€,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return INVALID;
  return roundTo(Number(cleaned), dp);
}

function parseNumberInput(v, { integer = false, min = null, max = null } = {}) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return INVALID;
  const n = Number(s);
  if (integer && !Number.isInteger(n)) return INVALID;
  if ((min != null && n < min) || (max != null && n > max)) return INVALID;
  return n;
}

/** 'YYYY-MM-DD' (what <input type="date"> sends) → UTC midnight Date | null | INVALID */
export function parseDateInput(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return INVALID;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : INVALID;
}

const str = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 500) : null;
};

// qs turns lines[0][description] into an array, but past 20 indexes into an
// object keyed by index; accept both.
const asLineList = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    return Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map((k) => raw[k]);
  }
  return [];
};

/** Which form a document gets (PB-2). Remittances and untyped documents get none. */
export function entryKind(doc) {
  if (isInvoiceDocument(doc)) return 'invoice';
  if (isDocumentType(doc?.documentType, 'bankStatement')) return 'bank';
  if (isDocumentType(doc?.documentType, 'supplierStatement')) return 'statement';
  return null;
}

/**
 * Parse a submitted entry form. Never throws.
 * @returns {{entry: object, errors: Record<string,string>}}
 */
export function parseEntryForm(body = {}, kind) {
  const errors = {};
  const take = (field, value, label) => {
    if (value === INVALID) { errors[field] = `${label} isn't valid.`; return null; }
    return value;
  };

  if (kind === 'bank') {
    const b = body.bank || {};
    const bank = {
      accountId: take('bank.accountId', parseNumberInput(b.accountId, { integer: true, min: 0 }), 'Bank account ID'),
      periodStart: take('bank.periodStart', parseDateInput(b.periodStart), 'Period start'),
      periodEnd: take('bank.periodEnd', parseDateInput(b.periodEnd), 'Period end'),
      openingBalance: take('bank.openingBalance', parseMoneyInput(b.openingBalance), 'Opening balance'),
      closingBalance: take('bank.closingBalance', parseMoneyInput(b.closingBalance), 'Closing balance'),
    };
    if (bank.periodStart && bank.periodEnd && bank.periodEnd < bank.periodStart) {
      errors['bank.periodEnd'] = 'Period end is before period start.';
    }
    return { entry: { bank }, errors };
  }

  if (kind !== 'invoice') return { entry: {}, errors };

  const entry = {
    invoiceNumber: str(body.invoiceNumber),
    invoiceDate: take('invoiceDate', parseDateInput(body.invoiceDate), 'Invoice date'),
    dueDate: take('dueDate', parseDateInput(body.dueDate), 'Due date'),
    totalGoods: take('totalGoods', parseMoneyInput(body.totalGoods), 'Total goods'),
    totalVat: take('totalVat', parseMoneyInput(body.totalVat), 'Total VAT'),
    invoiceTotal: take('invoiceTotal', parseMoneyInput(body.invoiceTotal), 'Invoice total'),
    lines: [],
  };

  asLineList(body.lines).forEach((raw, i) => {
    const n = i + 1;
    const line = {
      description: str(raw?.description),
      quantity: take(`lines.${i}.quantity`, parseNumberInput(raw?.quantity), `Line ${n} quantity`),
      price: take(`lines.${i}.price`, parseMoneyInput(raw?.price, { dp: 4 }), `Line ${n} price`),
      total: take(`lines.${i}.total`, parseMoneyInput(raw?.total), `Line ${n} total`),
      vatRate: null,
    };
    const rate = parseVatRate(raw?.vatRate);
    if (Number.isNaN(rate)) errors[`lines.${i}.vatRate`] = vatRateProblem(raw.vatRate, n);
    else line.vatRate = rate;
    // A completely blank row is how a line is removed
    if (Object.values(line).every((v) => v == null)) return;
    if (line.total == null && line.quantity != null && line.price != null) {
      line.total = roundTo(line.quantity * line.price, 2);
    }
    entry.lines.push(line);
  });

  return { entry, errors };
}

/** What must be filled in before Complete entry (PB-5). */
export function completionErrors(entry) {
  const errors = {};
  if (!entry) return { form: 'Nothing has been entered yet.' };
  if (!entry.invoiceNumber) errors.invoiceNumber = 'Invoice number is required.';
  if (!entry.invoiceDate) errors.invoiceDate = 'Invoice date is required.';
  if (entry.invoiceTotal == null) errors.invoiceTotal = 'Invoice total is required.';
  const lines = entry.lines || [];
  if (!lines.some((l) => l.description && l.total != null)) {
    errors.lines = 'At least one line needs a description and a total.';
  }
  return errors;
}

const money = (n) => (n == null ? '—' : Number(n).toFixed(2));
const off = (a, b) => Math.abs(a - b) > 0.01;

/** Totals that don't add up. Shown as warnings; the KashFlow send checks again. */
export function consistencyWarnings(entry) {
  if (!entry) return [];
  const out = [];
  const lines = entry.lines || [];
  lines.forEach((l, i) => {
    // Saved before VAT % was limited to the rates
    const badRate = l.vatRate != null ? vatRateProblem(l.vatRate, i + 1) : null;
    if (badRate) out.push(badRate);
    // A price kept to 4 places (bricks per thousand: 0.7945) can be out by half a
    // ten-thousandth a unit, so 5,000 bricks may be a few pence out
    const slack = Math.max(0.01, Math.abs(l.quantity ?? 0) * 0.00005);
    if (l.quantity != null && l.price != null && l.total != null && Math.abs(l.quantity * l.price - l.total) > slack + 1e-9) {
      out.push(`Line ${i + 1}: ${l.quantity} × ${money(l.price)} is ${money(l.quantity * l.price)}, not ${money(l.total)}.`);
    }
  });
  const lineSum = lines.reduce((s, l) => s + (l.total ?? 0), 0);
  if (entry.totalGoods != null && lines.some((l) => l.total != null) && off(lineSum, entry.totalGoods)) {
    out.push(`Line totals add up to ${money(lineSum)}, but total goods is ${money(entry.totalGoods)}.`);
  }
  const priced = lines.filter((l) => l.total != null);
  if (entry.totalVat != null && priced.length && priced.every((l) => l.vatRate != null && !Number.isNaN(parseVatRate(l.vatRate)))) {
    const lineVat = priced.reduce((s, l) => s + (l.total * l.vatRate) / 100, 0);
    // Suppliers round VAT per line or on the total, so allow a penny a line
    if (Math.abs(lineVat - entry.totalVat) > Math.max(0.02, 0.01 * priced.length) + 1e-9) {
      out.push(`VAT at the line rates comes to ${money(lineVat)}, but total VAT is ${money(entry.totalVat)}.`);
    }
  }
  if (entry.totalGoods != null && entry.totalVat != null && entry.invoiceTotal != null
      && off(entry.totalGoods + entry.totalVat, entry.invoiceTotal)) {
    out.push(`Goods ${money(entry.totalGoods)} + VAT ${money(entry.totalVat)} is ${money(entry.totalGoods + entry.totalVat)}, not the invoice total ${money(entry.invoiceTotal)}.`);
  }
  return out;
}

// ── Form values ──────────────────────────────────────────────────────

const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const cfValue = (doc, names) => {
  const wanted = names.map((n) => n.toLowerCase());
  const hit = (doc.customFields || []).find((cf) => wanted.includes(String(cf.fieldName || '').trim().toLowerCase()));
  return hit?.value ?? null;
};
const cfMoney = (doc, name) => {
  const v = parseMoneyInput(cfValue(doc, [name]));
  return v === INVALID ? null : v;
};
const cfDate = (doc, name) => {
  const v = cfValue(doc, [name]);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * What the form shows. The saved hcs-app entry when there is one; otherwise
 * whatever was already keyed into the Paperless custom fields, so nothing has
 * to be typed twice. `source` says which.
 */
export function formValues(doc) {
  const kind = entryKind(doc);
  const e = doc.entry;
  if (kind === 'bank') {
    const b = e?.bank;
    const v = b ? b : {
      accountId: cfValue(doc, ['Bank Account ID']),
      periodStart: cfDate(doc, 'Statement Period Start'),
      periodEnd: cfDate(doc, 'Statement Period End'),
      openingBalance: cfMoney(doc, 'Statement Opening Balance'),
      closingBalance: cfMoney(doc, 'Statement Closing Balance'),
    };
    return {
      source: b ? 'hcs-app' : 'paperless',
      bank: { ...v, periodStart: isoDate(v.periodStart), periodEnd: isoDate(v.periodEnd) },
    };
  }
  if (kind !== 'invoice') return { source: null };

  if (e && e.savedAt) {
    return {
      source: 'hcs-app',
      ...e,
      invoiceDate: isoDate(e.invoiceDate),
      dueDate: isoDate(e.dueDate),
      lines: (e.lines || []).map((l) => ({ ...l })),
    };
  }
  const lines = [];
  for (let n = 1; n <= 30; n++) {
    const line = {
      description: cfValue(doc, [`Description_Line${n}`]),
      quantity: (() => { const q = parseNumberInput(cfValue(doc, [`Qty_Line${n}`])); return q === INVALID ? null : q; })(),
      price: cfMoney(doc, `Price_Line${n}`),
      total: cfMoney(doc, `Total_Line${n}`),
      vatRate: (() => { const r = parseNumberInput(cfValue(doc, [`VAT_Line${n}`])); return r === INVALID ? null : r; })(),
    };
    if (Object.values(line).some((v) => v != null && v !== '')) lines.push(line);
  }
  return {
    source: 'paperless',
    invoiceNumber: cfValue(doc, ['Invoice Number']),
    invoiceDate: isoDate(cfDate(doc, 'Invoice Date')),
    dueDate: isoDate(cfDate(doc, 'Invoice Due Date')),
    totalGoods: cfMoney(doc, 'Total Goods'),
    totalVat: cfMoney(doc, 'Total VAT'),
    invoiceTotal: cfMoney(doc, 'Invoice Total'),
    lines,
  };
}

// ── Actions ──────────────────────────────────────────────────────────

const storedActor = (actor) => (actor ? { userId: actor.userId ?? null, name: actor.name ?? null } : null);

const defaultDeps = () => ({
  modifyTags: (id, changes) => modifyPaperlessDocumentTags(id, changes),
  setFields: (id, pairs) => __paperlessClient.makeClient().setDocumentCustomFields([id], pairs),
  // H6: in shadow mode this only records what would be sent
  notify: (kind, id, opts) => notifySafely(kind, id, opts),
});

/**
 * Give a document its first state if it has none yet, so the entry screen
 * works on documents that arrived before the H3 webhook.
 */
export async function ensureClassified(OcrDocument, paperlessId) {
  return classifyDocument(OcrDocument, paperlessId);
}

/** Save the entry. Refused once the invoice is in KashFlow. */
export async function saveEntry(OcrDocument, paperlessId, entry, actor, { now = new Date() } = {}) {
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType processingState').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (!entryKind(doc) || entryKind(doc) === 'statement') {
    return { ok: false, reason: 'no-form', message: 'This type of document has no fields to enter.' };
  }
  if (doc.processingState === 'sent') {
    return { ok: false, reason: 'locked', message: 'This invoice is already in KashFlow. Unlink it before changing what was entered.' };
  }
  const updated = await OcrDocument.findOneAndUpdate(
    { paperlessId, processingState: { $ne: 'sent' } },
    { $set: { entry: { ...entry, savedAt: now, savedBy: storedActor(actor) } } },
    { new: true },
  ).lean();
  if (!updated) return { ok: false, reason: 'conflict', message: 'The document changed while you were working on it. Reload and try again.' };
  return { ok: true, doc: updated };
}

async function tellPaperless(label, fn, manual) {
  try {
    await fn();
    return null;
  } catch (err) {
    logger.warn(`[documentEntry] ${label} failed: ${err.message}`);
    return `Saved in hcs-app, but Paperless couldn't be updated. ${manual}`;
  }
}

/** Complete entry (PB-5): requires the core fields, then tags Paperless. */
export async function completeEntry(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType processingState excludedReason entry').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  const excluded = notForEntryMessage(doc);
  if (excluded) return { ok: false, reason: 'excluded', message: excluded };
  const errors = completionErrors(doc.entry?.savedAt ? doc.entry : null);
  if (Object.keys(errors).length) {
    return { ok: false, reason: 'incomplete', errors, message: Object.values(errors).join(' ') };
  }
  const res = await transition(OcrDocument, paperlessId, 'complete_entry', actor);
  if (!res.ok) return res;
  const paperlessWarning = await tellPaperless(
    `Adding "data entry done" to ${paperlessId}`,
    () => d.modifyTags(paperlessId, { add: ['dataEntryDone'] }),
    'Add the "data entry done" tag in Paperless so the invoice email is sent.',
  );
  const notification = await d.notify('john', paperlessId, { actor });
  return { ...res, paperlessWarning, notification };
}

/** Credit Note checkbox (PB-9, PB-12). Unticking is admin-only. */
export async function setCreditNote(OcrDocument, paperlessId, flag, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const res = await transition(OcrDocument, paperlessId, flag ? 'flag_credit_note' : 'unflag_credit_note', actor);
  if (!res.ok) return res;
  const paperlessWarning = await tellPaperless(
    `Setting Credit Note=${flag} on ${paperlessId}`,
    () => d.setFields(paperlessId, { 'Credit Note': flag ? 'true' : 'false' }),
    flag ? 'Tick Credit Note in Paperless so the credit note email is sent.' : 'Untick Credit Note in Paperless.',
  );
  // One-shot: unflagging and flagging again does not send the credit note email twice
  const notification = flag ? await d.notify('credit_note', paperlessId, { actor }) : null;
  return { ...res, paperlessWarning, notification };
}

export const NOT_FOR_KASHFLOW_NOTE_MAX = 300;

/**
 * Not for KashFlow: a real invoice that must never be entered, e.g. one paid
 * with store credit from a refund, so the two net to nothing (#252/#253). It
 * leaves both queues, keeps its reason, and is tagged "not for kashflow" in
 * Paperless. Undoing it is admin-only and puts it back where it was.
 * @param {{flag: boolean, note?: string}} change
 */
export async function setNotForKashflow(OcrDocument, paperlessId, { flag, note = '' }, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('documentType processingState excludedReason excludedNote creditNote deletedInPaperlessAt').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };

  if (flag) {
    const reason = String(note || '').replace(/\s+/g, ' ').trim();
    if (!isInvoiceDocument(doc)) return { ok: false, reason: 'not-invoice', message: 'Only invoices can be marked not for KashFlow.' };
    if (doc.processingState === 'sent') {
      return { ok: false, reason: 'sent', message: "It's linked to a KashFlow purchase. Unlink it first." };
    }
    if (!['awaiting_entry', 'entered'].includes(doc.processingState) || doc.creditNote) {
      return { ok: false, reason: 'state', message: 'Only an invoice waiting for entry or to be sent can be marked not for KashFlow.' };
    }
    if (doc.excludedReason) return { ok: false, reason: 'excluded', message: notForEntryMessage(doc) };
    if (reason.length < 3) return { ok: false, reason: 'no-note', message: "Say why it isn't for KashFlow, so it makes sense later." };
    if (reason.length > NOT_FOR_KASHFLOW_NOTE_MAX) {
      return { ok: false, reason: 'long-note', message: `Keep the reason under ${NOT_FOR_KASHFLOW_NOTE_MAX} characters.` };
    }
    const res = await setExcludedReason(OcrDocument, paperlessId, 'not_for_kashflow', actor, { note: reason, excludedNote: reason });
    if (!res.ok) return res;
    const paperlessWarning = await tellPaperless(
      `Adding "not for kashflow" to ${paperlessId}`,
      () => d.modifyTags(paperlessId, { add: ['notForKashflow'] }),
      'Add the "not for kashflow" tag in Paperless.',
    );
    return { ...res, paperlessWarning };
  }

  if (doc.excludedReason !== 'not_for_kashflow') {
    return { ok: false, reason: 'not-marked', message: "It isn't marked not for KashFlow." };
  }
  const res = await setExcludedReason(OcrDocument, paperlessId, null, actor, { note: 'No longer not for KashFlow' });
  if (!res.ok) return res;
  // Or following Paperless's tags would mark it again
  const paperlessWarning = await tellPaperless(
    `Removing "not for kashflow" from ${paperlessId}`,
    () => d.modifyTags(paperlessId, { remove: ['notForKashflow'] }),
    'Remove the "not for kashflow" tag in Paperless, or it will be marked again.',
  );
  return { ...res, paperlessWarning };
}

/** Reopen entry (admin): back to Needs Data Entry, and untag Paperless. */
export async function reopenEntry(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const res = await transition(OcrDocument, paperlessId, 'reopen_entry', actor);
  if (!res.ok) return res;
  const paperlessWarning = await tellPaperless(
    `Removing "data entry done" from ${paperlessId}`,
    () => d.modifyTags(paperlessId, { remove: ['dataEntryDone'] }),
    'Remove the "data entry done" tag in Paperless.',
  );
  return { ...res, paperlessWarning };
}

/**
 * Resend to John (PB-6): always sends and is logged every time. Until
 * cutover it also adds the `notify` tag, so Paperless (WF9) does the sending.
 */
export async function resendToJohn(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const doc = await OcrDocument.findOne({ paperlessId }).select('documentType').lean();
  if (!doc) return { ok: false, reason: 'not-found', message: 'Document not found.' };
  if (!isDocumentType(doc.documentType, 'purchaseInvoice')) {
    return { ok: false, reason: 'not-applicable', message: 'Only purchase invoices have an invoice email.' };
  }
  const paperlessWarning = await tellPaperless(
    `Adding "notify" to ${paperlessId}`,
    () => d.modifyTags(paperlessId, { add: ['notify'] }),
    'Add the "notify" tag in Paperless to re-send it.',
  );
  const notification = await d.notify('john_resend', paperlessId, { actor });
  return { ok: true, paperlessWarning, notification };
}

/**
 * Mark a supplier statement reviewed (PB-10). The first time emails Bev.
 * Paperless isn't told: its WF2 already emails Bev on the first save there,
 * and adding tag 21 from here would stop that email before cutover.
 */
export async function markReviewed(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const res = await markStatementReviewed(OcrDocument, paperlessId, actor);
  if (!res.ok) return res;
  const notification = res.firstTime ? await d.notify('statement', paperlessId, { actor }) : null;
  return { ...res, notification };
}

/**
 * After a successful KashFlow send (D2): move the invoice to `sent`, via
 * `entered` if it was sent straight from the draft screen, and fire the
 * "added to kashflow" post (PB-8). Never throws: the purchase already exists.
 */
/**
 * Documents linked to a KashFlow purchase but not marked as sent, moved to In
 * KashFlow. Two ways in: from 6.47.0 until 6.53.1 a send created the purchase
 * and linked it, then failed before moving the document on; and Match Purchase
 * (and the other ways of linking an existing purchase) link without sending, so
 * the invoice stayed in Ready for KashFlow (#1139). Idempotent; sends no
 * notifications, since the purchase is already in KashFlow.
 * @param {{paperlessIds?: number[]}} [opts]  only these documents
 * @returns {Promise<{repaired: number[]}>}
 */
export async function repairUnmarkedSends(OcrDocument, { paperlessIds = null } = {}) {
  const docs = await OcrDocument.find({
    ...__kfSendClaim.LINKED_QUERY,
    processingState: { $in: ['awaiting_entry', 'entered'] },
    deletedInPaperlessAt: null,
    ...(paperlessIds ? { paperlessId: { $in: paperlessIds } } : {}),
  }).select('paperlessId processingState kashflowPurchaseId').lean();
  const repaired = [];
  const note = 'Already in KashFlow (linked to a purchase), so marked as sent';
  for (const doc of docs) {
    try {
      if (doc.processingState === 'awaiting_entry') {
        await transition(OcrDocument, doc.paperlessId, 'complete_entry', null, { note });
      }
      const r = await transition(OcrDocument, doc.paperlessId, 'mark_sent', null, { note });
      if (r.ok) repaired.push(doc.paperlessId);
    } catch (err) {
      logger.warn(`[documentEntry] Repairing the KashFlow send for ${doc.paperlessId} failed: ${err.message}`);
    }
  }
  if (repaired.length) logger.info(`[documentEntry] Marked ${repaired.length} document(s) as in KashFlow that had been sent but not recorded: ${repaired.join(', ')}`);
  return { repaired };
}

export async function recordSentToKashflow(OcrDocument, paperlessId, actor, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  try {
    const doc = await OcrDocument.findOne({ paperlessId }).select('documentType processingState').lean();
    if (doc?.processingState === 'awaiting_entry') {
      await transition(OcrDocument, paperlessId, 'complete_entry', actor, { note: 'Sent to KashFlow from the draft screen' });
    }
    const after = await OcrDocument.findOne({ paperlessId }).select('processingState').lean();
    if (after?.processingState === 'entered') {
      await transition(OcrDocument, paperlessId, 'mark_sent', actor);
    }
  } catch (err) {
    logger.warn(`[documentEntry] Recording the KashFlow send for ${paperlessId} failed: ${err.message}`);
  }
  return d.notify('kashflow', paperlessId, { actor });
}

/** After a KashFlow link is cleared (unlink or orphan clean-up): sent → entered. */
export async function recordUnlinked(OcrDocument, paperlessId, actor, { note = null } = {}) {
  try {
    const doc = await OcrDocument.findOne({ paperlessId }).select('processingState entry.savedAt').lean();
    if (doc?.processingState !== 'sent') return { ok: false, reason: 'not-sent' };
    // Nothing was ever entered (e.g. a split-out invoice that inherited its
    // original's link): it needs entering, not sending
    const action = doc.entry?.savedAt ? 'unlink' : 'unlink_unentered';
    return await transition(OcrDocument, paperlessId, action, actor, { note });
  } catch (err) {
    logger.warn(`[documentEntry] Recording the unlink for ${paperlessId} failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

export default {
  parseMoneyInput,
  parseDateInput,
  entryKind,
  parseEntryForm,
  completionErrors,
  consistencyWarnings,
  formValues,
  entryAsCustomFields,
  ensureClassified,
  saveEntry,
  completeEntry,
  setCreditNote,
  setNotForKashflow,
  NOT_FOR_KASHFLOW_NOTE_MAX,
  reopenEntry,
  resendToJohn,
  markReviewed,
  recordSentToKashflow,
  repairUnmarkedSends,
  recordUnlinked,
};
